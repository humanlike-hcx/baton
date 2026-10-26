import { modelFamily } from "./families.ts";
import { permissionLevel } from "./permissions.ts";
import type { AgentCard, Role, RunRecord, Stage, Thread, WorkspaceSettings } from "./types.ts";

export const USD_TO_CNY = 7.2;

export interface RouterInput {
  thread: Thread;
  agents: AgentCard[];
  settings: WorkspaceSettings;
  /** Whether the agent's credential route is usable right now. */
  available: (agent: AgentCard) => boolean;
}

export interface Selection {
  chosen?: AgentCard;
  candidates: AgentCard[];
  rejected: { id: string; name: string; reason: string }[];
}

export function roleForStage(stage: Stage): Role {
  return stage === "plan" ? "plan" : stage === "review" ? "review" : "implement";
}

export function lastRun(thread: Thread, stage?: Stage): RunRecord | undefined {
  for (let i = thread.runs.length - 1; i >= 0; i--) {
    const run = thread.runs[i]!;
    if (run.role === "advisor") continue;
    if (!stage || run.stage === stage) return run;
  }
  return undefined;
}

function quotaReason(agent: AgentCard, thread: Thread, settings: WorkspaceSettings): string | undefined {
  const { limits } = settings;
  if (agent.source === "deepseek" && thread.spend.deepseekCny >= limits.deepseekCnyPerThread) {
    return `DeepSeek 花费已达上限 ¥${limits.deepseekCnyPerThread}`;
  }
  if (agent.source === "chatgpt" && thread.spend.chatgptRuns >= limits.chatgptRunsPerThread) {
    return `ChatGPT 次数已达上限 ${limits.chatgptRunsPerThread}`;
  }
  if (agent.source === "cursor" && thread.spend.cursorRuns >= limits.cursorRunsPerThread) {
    return `Cursor 次数已达上限 ${limits.cursorRunsPerThread}`;
  }
  return undefined;
}

/** Order: owns the role → permissions suffice → quota available → cheapest first. */
export function selectAgent(stage: Stage, input: RouterInput, options: { role?: Role; preferred?: string } = {}): Selection {
  const { thread, agents, settings } = input;
  const role = options.role ?? roleForStage(stage);
  const rejected: Selection["rejected"] = [];
  const author = role === "review" ? lastRun(thread, "implement") : undefined;
  const authorFamily = author?.family;
  const candidates: AgentCard[] = [];
  for (const agent of agents) {
    const reject = (reason: string) => rejected.push({ id: agent.id, name: agent.name, reason });
    if (!agent.roles.includes(role)) continue;
    if (!agent.enabled) {
      reject("已停用");
      continue;
    }
    if (role === "implement" && !agent.permissions.write) {
      reject("没有写权限，不能承担实现");
      continue;
    }
    if (role === "advisor" && (agent.permissions.write || agent.permissions.exec === "allow")) {
      reject("顾问必须只读");
      continue;
    }
    if (!input.available(agent)) {
      reject("账号未登录或不可用");
      continue;
    }
    const quota = quotaReason(agent, thread, settings);
    if (quota) {
      reject(quota);
      continue;
    }
    if (authorFamily && modelFamily(agent.model, agent.provider) === authorFamily) {
      reject(`与实现者同属 ${authorFamily} 家族，不能检查自己的改动`);
      continue;
    }
    candidates.push(agent);
  }
  candidates.sort((a, b) => a.costTier - b.costTier || a.name.localeCompare(b.name));
  const preferred = options.preferred ?? thread.pinnedAgents[stage];
  const chosen = candidates.find((a) => a.id === preferred) ?? candidates[0];
  return { chosen, candidates, rejected };
}

export type Transition =
  | { kind: "advance"; to: Stage; reason: string; sendBack?: boolean }
  | { kind: "complete"; reason: string }
  | { kind: "violation"; rule: string; detail: string; to?: Stage; sendBack?: boolean }
  | { kind: "pause"; reason: string };

const ALLOWED: Record<Stage, Stage[]> = {
  plan: ["implement", "review"],
  implement: ["review"],
  review: ["implement", "done"],
  done: [],
};

export function isStall(run: RunRecord): boolean {
  return run.changedFiles.length === 0 && run.decisions === 0 && !run.handoff?.verdict && !run.proposedNext;
}

/** Decides where the thread goes after a finished run, enforcing the hard rules. */
export function nextTransition(thread: Thread, run: RunRecord, settings: WorkspaceSettings): Transition {
  if (run.status === "cancelled") return { kind: "pause", reason: "运行已取消" };
  if (run.status === "failed") return { kind: "pause", reason: `运行失败：${run.error ?? "未知错误"}` };
  const { limits } = settings;

  let to: Stage;
  let reason: string;
  let sendBack = false;
  if (run.stage === "plan") {
    to = run.proposedNext?.stage ?? "implement";
    reason = run.proposedNext?.reason ?? "方案阶段结束";
  } else if (run.stage === "implement") {
    to = "review";
    reason = "实现完成，进入检查";
  } else if (run.stage === "review") {
    const verdict = run.handoff?.verdict;
    const checksFailed = run.checks?.some((c) => c.status === "fail" || c.status === "error") ?? false;
    if (verdict === "pass" && !checksFailed) return { kind: "complete", reason: "检查通过" };
    if (!verdict) return { kind: "violation", rule: "检查没有给出结论", detail: "检查角色没有给出 pass / fail，不能自动推进。" };
    to = "implement";
    sendBack = true;
    reason = verdict === "pass" ? "模型判定通过，但检查命令没有通过" : `检查不通过：${(run.handoff?.issues ?? []).join("；")}`;
  } else {
    return { kind: "pause", reason: "线程已完成" };
  }

  if (!ALLOWED[run.stage].includes(to)) {
    return { kind: "violation", rule: "不允许的接力方向", detail: `${run.stage} 不能直接交给 ${to}；退回只能走「检查 → 实现」。` };
  }
  if (sendBack && thread.sendBacks >= limits.maxSendBacks) {
    return { kind: "violation", rule: "退回次数已达上限", detail: `已经退回 ${thread.sendBacks} 轮（上限 ${limits.maxSendBacks}）。${reason}`, to, sendBack };
  }
  if (thread.stalls >= limits.maxStalls) {
    return { kind: "violation", rule: "连续空转", detail: `连续 ${thread.stalls} 跳既没有改文件，也没有新决定。`, to, sendBack };
  }
  if (thread.hops >= limits.maxHops + thread.extraHops) {
    return { kind: "violation", rule: "接力跳数已达上限", detail: `本线程已自动接力 ${thread.hops} 跳（上限 ${limits.maxHops + thread.extraHops}）。`, to, sendBack };
  }
  return { kind: "advance", to, reason, sendBack };
}

export function needsEscalationApproval(thread: Thread, next: AgentCard): boolean {
  return permissionLevel(next) > thread.approvedLevel;
}

export type AdvisorTrigger = "second_send_back" | "repeated_issues" | "before_plan";

export function advisorTrigger(thread: Thread, run: RunRecord, transition: Transition, settings: WorkspaceSettings): AdvisorTrigger | undefined {
  const { advisor } = settings;
  if (run.stage === "plan" && advisor.beforePlan && transition.kind === "advance") return "before_plan";
  const sendBack = (transition.kind === "advance" || transition.kind === "violation") && transition.sendBack;
  if (!sendBack) return undefined;
  if (advisor.onSecondSendBack && thread.sendBacks + 1 === 2) return "second_send_back";
  if (advisor.onRepeatedIssues && thread.reviewIssueRounds >= 2) return "repeated_issues";
  return undefined;
}

export const ADVISOR_TRIGGER_LABEL: Record<AdvisorTrigger, string> = {
  second_send_back: "第二次退回",
  repeated_issues: "检查连续两轮报出新问题",
  before_plan: "方案定方向之前",
};
