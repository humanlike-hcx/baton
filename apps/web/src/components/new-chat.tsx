import { useState } from "react";
import { ArrowUp, FolderOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import { ACCESS } from "@/lib/format";
import { findModel, lastModel, pickBody, rememberModel, toChatModel, usableModels, useModels } from "@/lib/models";
import { chooseProjectDirectory, useSwitchProject } from "@/lib/projects";
import { href, navigate } from "@/lib/router";
import { useBaton } from "@/lib/store";
import type { ChatAccess, ChatModel, Thread } from "@/lib/types";
import { AccessSwitch } from "./access-switch";
import { ModelPicker } from "./model-picker";

const OPEN_OTHER = "__open_other__";

/** What Baton opens into: an empty chat in the current project, ready for the first message. */
export function NewChat() {
  const { state, error } = useBaton();
  const { routes } = useModels();
  const switchProject = useSwitchProject();
  const pickProject = (root: string) => switchProject(root).catch((e: Error) => toast.error(e.message));
  const [picked, setPicked] = useState<ChatModel>();
  const [access, setAccess] = useState<ChatAccess>("read");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const demo = state?.workspace.demo ?? false;
  const remembered = findModel(routes, lastModel());
  const fallback = (remembered && !remembered.route.unavailable ? remembered : undefined) ?? usableModels(routes, demo)[0];
  const model = picked ?? (fallback ? toChatModel(fallback) : undefined);

  const send = async () => {
    if (!text.trim() || !model || sending) return;
    setSending(true);
    try {
      const body = { ...pickBody(model), workspace: state?.workspace.root };
      let thread: Thread;
      if (access === "read") {
        thread = await post<Thread>("/api/threads", { ...body, task: text });
      } else {
        thread = await post<Thread>("/api/threads", { ...body, task: "", title: text.replace(/\s+/g, " ").slice(0, 40) });
        await post(`/api/threads/${thread.id}/access`, { access });
        await post(`/api/threads/${thread.id}/messages`, { text });
      }
      rememberModel(model);
      navigate({ page: "threads", threadId: thread.id });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  if (error && !state) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <div>
          <p className="text-sm font-medium">连不上本地服务</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-6 pt-[20dvh]">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  const noModel = routes && !fallback;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center px-4 py-10 sm:px-6">
        <h1 className="text-center text-2xl font-semibold">在 {state.workspace.name} 里聊点什么？</h1>
        <p className="mt-2 text-center text-sm text-muted-foreground">选一个模型直接聊，随时可以换。改了文件之后，可以让另一个模型检查。</p>

        <div className="mt-6 rounded-2xl border bg-card p-3 shadow-sm focus-within:ring-2 focus-within:ring-ring/30">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            autoFocus
            aria-label="第一条消息"
            placeholder="例如：帮我看看 src/ 下面的结构，哪里适合加一个导出配置的按钮？"
            className="resize-none border-0 p-1 shadow-none focus-visible:ring-0"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Select
              value={state.workspace.root}
              onValueChange={(root) => {
                if (root !== OPEN_OTHER) return void pickProject(root);
                void chooseProjectDirectory()
                  .then((picked) => picked && pickProject(picked))
                  .catch((e: Error) => toast.error(e.message));
              }}
            >
              <SelectTrigger size="sm" className="max-w-48" aria-label="在哪个项目里">
                <FolderOpen className="text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {state.projects.map((p) => (
                  <SelectItem key={p.root} value={p.root} title={p.root}>
                    {p.name}
                    {p.demo && <span className="text-xs text-muted-foreground">演示</span>}
                  </SelectItem>
                ))}
                <SelectSeparator />
                <SelectItem value={OPEN_OTHER}>打开其他项目…</SelectItem>
              </SelectContent>
            </Select>
            <ModelPicker value={model} onChange={setPicked} className="max-w-72 min-w-44" />
            <AccessSwitch value={access} onChange={setAccess} />
            <Button size="icon" className="ml-auto" disabled={!text.trim() || !model || sending} onClick={() => void send()} aria-label="发送">
              {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
            </Button>
          </div>
        </div>
        <p className="mt-2 px-1 text-xs text-muted-foreground">
          {ACCESS.find((a) => a.value === access)?.hint}。Enter 发送，Shift + Enter 换行。
        </p>

        {noModel && (
          <div className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
            还没有能用的模型。到
            <a className="mx-1 text-primary underline-offset-2 hover:underline" href={href({ page: "models" })}>
              「模型」页
            </a>
            登录 ChatGPT、Cursor，或添加任意服务的 API key。
          </div>
        )}
        {state.workspace.demo && (
          <div className="mt-6 rounded-xl border border-violet-500/30 bg-violet-500/5 p-4 text-sm">
            <div className="font-medium">这是演示工作区</div>
            <p className="mt-1 text-muted-foreground">
              「演示」账号下的模型用脚本化的假模型回复，不消耗任何额度。试试：把权限切到「允许直接改」，发「写文件：notes/todo.md TODO 补测试」，
              再点「让另一个模型检查」：先跑检查命令，再由另一个模型审查，留着 TODO 的改动会被判不通过。接入真实模型请到
              <a className="mx-1 underline" href={href({ page: "models" })}>
                「模型」页
              </a>
              登录，再在左边「项目」旁的文件夹按钮里打开你自己的项目目录。演示里的对话不受影响，随时能回来看。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
