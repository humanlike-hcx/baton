import { useEffect, useState, type ReactNode } from "react";
import { ChevronsUpDown, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, post } from "@/lib/api";
import { SOURCE_LABEL } from "@/lib/format";
import { useBaton } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { AgentCard, AgentView, ModelsResponse } from "@/lib/types";

type ChatSource = "chatgpt" | "deepseek" | "cursor";
const ROUTES: { source: ChatSource; label: string }[] = [
  { source: "chatgpt", label: "ChatGPT" },
  { source: "deepseek", label: "DeepSeek" },
  { source: "cursor", label: "Cursor" },
];

/**
 * Who replies in a chat: an existing agent, or any model a signed-in route offers.
 * Picking a model without a card creates a chat-only card for it on the server.
 */
export function ChatAgentPicker({
  agents,
  value,
  onChange,
  className,
  size = "sm",
}: {
  agents: AgentView[];
  value?: string;
  onChange: (id: string) => void;
  className?: string;
  size?: "sm" | "default";
}) {
  const { state, refresh } = useBaton();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<ModelsResponse>();
  const [loadError, setLoadError] = useState<string>();
  const [creating, setCreating] = useState<string>();
  const current = agents.find((a) => a.id === value);
  const enabled = agents.filter((a) => a.enabled);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoadError(undefined);
    api<ModelsResponse>("/api/models").then(
      (m) => live && setModels(m),
      (e: Error) => live && setLoadError(e.message),
    );
    return () => {
      live = false;
    };
  }, [open]);

  const signedIn: Record<ChatSource, boolean> = {
    chatgpt: Boolean(state?.auth.chatgpt.loggedIn),
    deepseek: Boolean(state?.auth.deepseek.configured),
    cursor: Boolean(state?.auth.cursor.loggedIn),
  };
  const q = query.trim().toLowerCase();
  const matches = (...texts: string[]) => !q || texts.some((t) => t.toLowerCase().includes(q));

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };
  const pickModel = async (source: ChatSource, model: string) => {
    const card = enabled.find((a) => a.source === source && a.model === model);
    if (card) return choose(card.id);
    setCreating(`${source}/${model}`);
    try {
      const agent = await post<AgentCard>("/api/agents/chat", { source, model });
      await refresh();
      choose(agent.id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(undefined);
    }
  };

  const agentRows = enabled.filter((a) => matches(a.name, a.model, SOURCE_LABEL[a.source]));
  return (
    <>
      <Button
        variant="outline"
        size={size}
        className={cn("justify-between font-normal", className)}
        aria-label="回复的 agent"
        onClick={() => setOpen(true)}
      >
        <span className="truncate">{current ? `${current.name} · ${SOURCE_LABEL[current.source]}` : "选择模型或 agent"}</span>
        <ChevronsUpDown className="opacity-50" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>和谁聊</DialogTitle>
            <DialogDescription>选已有的 agent，或任一已登录线路上的模型。没有卡片的模型会自动建一张只用于对话的卡片。</DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索模型或 agent" className="pl-8" />
          </div>
          <div className="-mx-2 max-h-[60dvh] space-y-4 overflow-y-auto px-2">
            {agentRows.length > 0 && (
              <section>
                <h3 className="mb-1 text-xs font-medium text-muted-foreground">已有的 agent</h3>
                {agentRows.map((a) => (
                  <Row key={a.id} active={a.id === value} disabled={!a.available} onClick={() => choose(a.id)}>
                    <span className="truncate">{a.name}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {SOURCE_LABEL[a.source]}
                      {!a.available && "（未登录）"}
                    </span>
                  </Row>
                ))}
              </section>
            )}
            {ROUTES.map(({ source, label }) => {
              const list = (models?.[source] ?? []).filter((m) => matches(m.name, m.id, label));
              return (
                <section key={source}>
                  <h3 className="mb-1 text-xs font-medium text-muted-foreground">
                    {label} 线路的模型{models && signedIn[source] ? `（${list.length}）` : ""}
                  </h3>
                  {!signedIn[source] ? (
                    <p className="px-2 py-1 text-xs text-muted-foreground">未登录，到设置页登录后可用。</p>
                  ) : !models ? (
                    <p className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
                      {loadError ?? (
                        <>
                          <Loader2 className="size-3 animate-spin" />
                          正在读取模型列表…
                        </>
                      )}
                    </p>
                  ) : source === "cursor" && models.cursorError ? (
                    <p className="px-2 py-1 text-xs text-destructive">{models.cursorError}</p>
                  ) : list.length === 0 ? (
                    <p className="px-2 py-1 text-xs text-muted-foreground">{q ? "没有匹配的模型" : "这条线路没有可用模型"}</p>
                  ) : (
                    list.map((m) => {
                      const card = enabled.find((a) => a.source === source && a.model === m.id);
                      const key = `${source}/${m.id}`;
                      return (
                        <Row key={key} active={Boolean(card && card.id === value)} disabled={Boolean(creating)} onClick={() => void pickModel(source, m.id)}>
                          <span className="truncate">{m.name}</span>
                          {m.name !== m.id && <span className="truncate text-xs text-muted-foreground">{m.id}</span>}
                          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                            {creating === key ? <Loader2 className="size-3 animate-spin" /> : card ? card.name : ""}
                          </span>
                        </Row>
                      );
                    })
                  )}
                </section>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Row({ active, disabled, onClick, children }: { active: boolean; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:pointer-events-none disabled:opacity-50",
        active && "bg-accent",
      )}
    >
      {children}
    </button>
  );
}
