import { useState, type ReactNode } from "react";
import { ChevronsUpDown, Loader2, RefreshCw, Search } from "lucide-react";
import { familyLabel } from "@baton/core/families";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SOURCE_LABEL } from "@/lib/format";
import { findModel, sameModel, shortReason, toChatModel, useModels, type ModelRef } from "@/lib/models";
import { href } from "@/lib/router";
import type { ChatModel } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Every model of every account route, searchable; models on a route that isn't signed in can't be picked. */
export function ModelPicker({
  value,
  onChange,
  authorFamily,
  title = "选择模型",
  description = "三个账号下的全部模型。没登录的账号先到「模型」页登录。",
  className,
  size = "sm",
}: {
  value?: ModelRef;
  onChange: (model: ChatModel) => void;
  /** Review: the family of the model that made the changes; models of the same family are marked. */
  authorFamily?: string;
  title?: string;
  description?: string;
  className?: string;
  size?: "sm" | "default";
}) {
  const { routes, error, loading, refresh } = useModels();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = findModel(routes, value);
  const q = query.trim().toLowerCase();
  const matches = (...texts: string[]) => !q || texts.some((t) => t.toLowerCase().includes(q));

  const choose = (model: ChatModel) => {
    onChange(model);
    setOpen(false);
    setQuery("");
  };

  return (
    <>
      <Button variant="outline" size={size} className={cn("justify-between font-normal", className)} aria-label="回复的模型" onClick={() => setOpen(true)}>
        <span className="truncate">{current ? `${current.option.name} · ${current.route.label}` : value ? `${value.model} · ${SOURCE_LABEL[value.source]}` : "选择模型"}</span>
        <ChevronsUpDown className="opacity-50" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索模型、家族或账号" className="pl-8" />
            </div>
            <Button variant="ghost" size="icon" onClick={() => void refresh()} aria-label="刷新模型列表" title="刷新模型列表">
              <RefreshCw className={cn(loading && "animate-spin")} />
            </Button>
          </div>
          <div className="-mx-2 max-h-[60dvh] space-y-4 overflow-y-auto px-2">
            {!routes && (
              <p className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
                {error ?? (
                  <>
                    <Loader2 className="size-3 animate-spin" /> 正在读取模型列表…
                  </>
                )}
              </p>
            )}
            {routes?.map((route) => {
              const list = route.models.filter((m) => matches(m.name, m.id, route.label, familyLabel(m.family)));
              if (q && list.length === 0) return null;
              return (
                <section key={route.source}>
                  <h3 className="mb-1 text-xs font-medium text-muted-foreground">
                    {route.label}
                    {!route.unavailable && list.length > 0 && `（${list.length}）`}
                  </h3>
                  {route.unavailable ? (
                    <p className="px-2 py-1 text-xs text-muted-foreground">
                      {shortReason(route.unavailable)}。
                      <a href={href({ page: "models" })} onClick={() => setOpen(false)} className="text-primary underline-offset-2 hover:underline">
                        去「模型」页
                      </a>
                    </p>
                  ) : route.error ? (
                    <p className="px-2 py-1 text-xs text-destructive">{route.error}</p>
                  ) : list.length === 0 ? (
                    <p className="px-2 py-1 text-xs text-muted-foreground">这个账号下没有可用模型</p>
                  ) : (
                    list.map((m) => {
                      const ref = { source: route.source, model: m.id };
                      const same = authorFamily !== undefined && m.family === authorFamily;
                      return (
                        <Row key={m.id} active={sameModel(ref, value)} onClick={() => choose(toChatModel({ route, option: m }))}>
                          <span className="truncate">{m.name}</span>
                          {m.name !== m.id && <span className="truncate text-xs text-muted-foreground">{m.id}</span>}
                          <span className={cn("ml-auto shrink-0 text-xs", same ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>
                            {same ? "和改动作者同家族" : familyLabel(m.family)}
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

function Row({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent", active && "bg-accent")}>
      {children}
    </button>
  );
}
