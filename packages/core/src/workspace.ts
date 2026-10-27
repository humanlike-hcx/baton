import fs from "node:fs";
import path from "node:path";
import {
  AGENTS_MD_BEGIN,
  AGENTS_MD_END,
  AGENTS_MD_SECTION,
  CONTEXT_TEMPLATE,
  RULE_FILES,
  defaultAgents,
  defaultSettings,
} from "./defaults.ts";
import { normalizePermissions } from "./permissions.ts";
import type { AgentCard, Thread, WorkspaceSettings } from "./types.ts";
import { nowIso, parseFrontmatter, readJson, readText, stringifyFrontmatter, writeFileAtomic } from "./util.ts";

export class Workspace {
  readonly root: string;
  readonly dir: string;

  private constructor(root: string) {
    this.root = root;
    this.dir = path.join(root, ".baton");
  }

  static open(root: string, options: { demo?: boolean } = {}): Workspace {
    const resolved = fs.realpathSync(path.resolve(root));
    const ws = new Workspace(resolved);
    ws.init(options.demo ?? false);
    return ws;
  }

  static isInitialized(root: string): boolean {
    return fs.existsSync(path.join(root, ".baton", "workspace.json"));
  }

  path(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  private init(demo: boolean): void {
    for (const sub of ["rules", "agents", "memory", "lessons", "handoffs", "threads", "sessions"]) {
      fs.mkdirSync(this.path(sub), { recursive: true });
    }
    if (!fs.existsSync(this.path("workspace.json"))) {
      const settings = defaultSettings(path.basename(this.root));
      if (demo) settings.checks = [{ name: "笔记已生成", command: "ls notes", timeoutSec: 30 }];
      this.saveSettings(settings);
      for (const agent of defaultAgents(demo)) this.saveAgent(agent);
    }
    // Earlier versions seeded every workspace with disabled demo agents; real workspaces drop them.
    if (!demo) for (const agent of this.listAgents()) if (agent.source === "demo") this.deleteAgent(agent.id);
    for (const [name, content] of Object.entries(RULE_FILES)) {
      const file = this.path("rules", name);
      if (!fs.existsSync(file)) writeFileAtomic(file, content);
    }
    if (!fs.existsSync(this.path("CONTEXT.md"))) writeFileAtomic(this.path("CONTEXT.md"), CONTEXT_TEMPLATE);
    const ignore = this.path(".gitignore");
    if (!fs.existsSync(ignore)) writeFileAtomic(ignore, "shadow.git/\nsessions/\naudit.jsonl\n");
    this.ensureAgentsMd();
  }

  ensureAgentsMd(): void {
    const file = path.join(this.root, "AGENTS.md");
    const current = readText(file);
    const start = current.indexOf(AGENTS_MD_BEGIN);
    const end = current.indexOf(AGENTS_MD_END);
    let next: string;
    if (start >= 0 && end > start) {
      next = current.slice(0, start) + AGENTS_MD_SECTION + current.slice(end + AGENTS_MD_END.length);
    } else {
      next = current.trim() ? `${current.trimEnd()}\n\n${AGENTS_MD_SECTION}\n` : `# AGENTS\n\n${AGENTS_MD_SECTION}\n`;
    }
    if (next !== current) writeFileAtomic(file, next);
  }

  /** Register the baton MCP server for Cursor, keeping other servers intact. */
  ensureCursorMcp(server: { command: string; args: string[]; env?: Record<string, string> }): void {
    const file = path.join(this.root, ".cursor", "mcp.json");
    const config = readJson<{ mcpServers?: Record<string, unknown> }>(file, {});
    config.mcpServers = { ...(config.mcpServers ?? {}), baton: server };
    writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`);
  }

  settings(): WorkspaceSettings {
    const base = defaultSettings(path.basename(this.root));
    const saved = readJson<Partial<WorkspaceSettings>>(this.path("workspace.json"), {});
    return {
      ...base,
      ...saved,
      limits: { ...base.limits, ...saved.limits },
      confirm: { ...base.confirm, ...saved.confirm },
      advisor: { ...base.advisor, ...saved.advisor },
      permissions: { ...base.permissions, ...saved.permissions },
      memory: { ...base.memory, ...saved.memory },
      budgets: { ...base.budgets, ...saved.budgets },
      cursor: { ...base.cursor, ...saved.cursor },
      version: 1,
    };
  }

  saveSettings(settings: WorkspaceSettings): void {
    writeFileAtomic(this.path("workspace.json"), `${JSON.stringify(settings, null, 2)}\n`);
  }

  listAgents(): AgentCard[] {
    const dir = this.path("agents");
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => this.readAgentFile(path.join(dir, f)))
      .filter((a): a is AgentCard => a !== undefined);
  }

  getAgent(id: string): AgentCard | undefined {
    return this.readAgentFile(this.path("agents", `${id}.md`));
  }

  private readAgentFile(file: string): AgentCard | undefined {
    if (!fs.existsSync(file)) return undefined;
    const { data, body } = parseFrontmatter<AgentCard>(readText(file));
    const id = path.basename(file, ".md");
    return {
      id,
      name: data.name ?? id,
      runtime: data.runtime ?? "pi",
      source: data.source ?? "demo",
      provider: data.provider ?? "demo",
      model: data.model ?? "",
      roles: data.roles ?? [],
      permissions: normalizePermissions(data.permissions),
      costTier: data.costTier ?? 2,
      enabled: data.enabled ?? true,
      body,
    };
  }

  saveAgent(agent: AgentCard): void {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(agent.id)) throw new Error(`agent id 只能包含小写字母、数字和连字符：${agent.id}`);
    const { body, id: _id, ...data } = agent;
    writeFileAtomic(this.path("agents", `${agent.id}.md`), stringifyFrontmatter(data, body));
  }

  deleteAgent(id: string): void {
    fs.rmSync(this.path("agents", `${id}.md`), { force: true });
  }

  listRules(): { name: string; content: string }[] {
    return fs
      .readdirSync(this.path("rules"))
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((name) => ({ name, content: this.readRule(name) }));
  }

  readRule(name: string): string {
    return readText(this.path("rules", path.basename(name)));
  }

  writeRule(name: string, content: string): void {
    if (!/^[a-z0-9-]+\.md$/.test(name)) throw new Error(`规则文件名不合法：${name}`);
    writeFileAtomic(this.path("rules", name), content);
  }

  readContext(): string {
    return readText(this.path("CONTEXT.md"));
  }

  /** Called after every write to CONTEXT.md, whoever made it (the UI, an agent's tool, the tidier). */
  onContextWrite?: () => void;

  writeContext(text: string): void {
    writeFileAtomic(this.path("CONTEXT.md"), text.endsWith("\n") ? text : `${text}\n`);
    this.onContextWrite?.();
  }

  listThreads(): Thread[] {
    return fs
      .readdirSync(this.path("threads"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson<Thread | null>(this.path("threads", f), null))
      .filter((t): t is Thread => t !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  loadThread(id: string): Thread | undefined {
    if (!/^[a-z0-9_]+$/.test(id)) return undefined;
    return readJson<Thread | undefined>(this.path("threads", `${id}.json`), undefined);
  }

  saveThread(thread: Thread): void {
    writeFileAtomic(this.path("threads", `${thread.id}.json`), JSON.stringify(thread, null, 1));
  }

  audit(entry: Record<string, unknown>): void {
    fs.appendFileSync(this.path("audit.jsonl"), `${JSON.stringify({ at: nowIso(), ...entry })}\n`);
  }
}
