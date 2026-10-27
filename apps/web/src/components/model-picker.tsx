import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronsUpDown, Loader2, RefreshCw, Search, Sparkles } from "lucide-react";
import { familyLabel, thinkingLabel } from "@baton/core/families";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SOURCE_LABEL } from "@/lib/format";
import { effortRank, entryOf, pickVariant, routeEntries, routeKey, shortReason, toChatModel, useModels, type ModelEntry, type ModelRef } from "@/lib/models";
import { href } from "@/lib/router";
import type { ChatModel, ModelOption, ModelRoute, ThinkingLevel } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The model a picked entry starts on: Cursor keeps the current effort where the new model has it; Pi keeps the thinking level where supported. */
function chooseFrom(entry: ModelEntry, current?: ModelRef, currentOption?: ModelOption): ChatModel {
  const option = entry.options.length > 1 ? pickVariant(entry.options, currentOption?.variant) : entry.options[0]!;
  const model = toChatModel({ route: entry.route, option });
  if (current?.thinking && option.thinking?.includes(current.thinking)) model.thinking = current.thinking;
  return model;
}

/** Short level text for a model: Pi's thinking level, or Cursor's variant. */
export function levelText(option: ModelOption | undefined, thinking?: ThinkingLevel): string | undefined {
  if (option?.thinking) return thinkingLabel(thinking);
  const v = option?.variant;
  if (!v) return undefined;
  const parts = [v.effort ? thinkingLabel(v.effort) : undefined, v.reasoning ? "思考" : undefined, v.fast ? "快速" : undefined].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

/** Every model of every account route, searchable; Cursor's variants of one model are one row. Models on a route that can't be used can't be picked. */
export function ModelPickerDialog({
  open,
  onOpenChange,
  value,
  onChange,
  authorFamily,
  title = "选择模型",
  description = "已登录的订阅和已添加的 API key 下的全部模型。思考档位选好模型后在输入框里切换。",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value?: ModelRef;
  onChange: (model: ChatModel) => void;
  /** Review: the family of the model that made the changes; models of the same family are marked. */
  authorFamily?: string;
  title?: string;
  description?: string;
}) {
  const { routes, error, loading, refresh } = useModels();
  const [query, setQuery] = useState("");
  const current = entryOf(routes, value);
  const q = query.trim().toLowerCase();
  const matches = (entry: ModelEntry) => !q || [entry.name, entry.route.label, familyLabel(entry.family), ...entry.options.map((o) => o.id)].some((t) => t.toLowerCase().includes(q));

  const choose = (model: ChatModel) => {
    onChange(model);
    onOpenChange(false);
    setQuery("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
          {routes?.map((route) => (
            <RouteSection key={routeKey(route)} route={route} matches={matches} query={q} current={current?.entry} authorFamily={authorFamily} onPick={(entry) => choose(chooseFrom(entry, value, current?.option))} onLeave={() => onOpenChange(false)} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RouteSection({
  route,
  matches,
  query,
  current,
  authorFamily,
  onPick,
  onLeave,
}: {
  route: ModelRoute;
  matches: (e: ModelEntry) => boolean;
  query: string;
  current?: ModelEntry;
  authorFamily?: string;
  onPick: (e: ModelEntry) => void;
  onLeave: () => void;
}) {
  const list = routeEntries(route).filter(matches);
  if (query && list.length === 0) return null;
  return (
    <section>
      <h3 className="mb-1 text-xs font-medium text-muted-foreground">
        {route.label}
        {!route.unavailable && list.length > 0 && `（${list.length}）`}
      </h3>
      {route.unavailable ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          {shortReason(route.unavailable)}。
          <a href={href({ page: "models" })} onClick={onLeave} className="text-primary underline-offset-2 hover:underline">
            去「模型」页
          </a>
        </p>
      ) : route.error ? (
        <p className="px-2 py-1 text-xs text-destructive">{route.error}</p>
      ) : list.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">这个账号下没有可用模型</p>
      ) : (
        list.map((entry) => {
          const same = authorFamily !== undefined && entry.family === authorFamily;
          const levels = entry.options.length > 1 ? `${entry.options.length} 个档位` : entry.options[0]!.thinking ? "可选思考档位" : undefined;
          return (
            <Row key={entry.key} active={current?.key === entry.key} onClick={() => onPick(entry)}>
              <span className="truncate">{entry.name}</span>
              {levels && <span className="shrink-0 text-xs text-muted-foreground">{levels}</span>}
              <span className={cn("ml-auto shrink-0 text-xs", same ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>{same ? "和改动作者同家族" : familyLabel(entry.family)}</span>
            </Row>
          );
        })
      )}
    </section>
  );
}

function Row({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent", active && "bg-accent")}>
      {children}
    </button>
  );
}

/** A button that opens the picker, for dialogs (the composer uses `ModelMenu`). */
export function ModelPicker({
  value,
  onChange,
  authorFamily,
  title,
  description,
  className,
}: {
  value?: ModelRef;
  onChange: (model: ChatModel) => void;
  authorFamily?: string;
  title?: string;
  description?: string;
  className?: string;
}) {
  const { routes } = useModels();
  const [open, setOpen] = useState(false);
  const current = entryOf(routes, value);
  const level = levelText(current?.option, value?.thinking);
  return (
    <>
      <Button variant="outline" className={cn("justify-between font-normal", className)} aria-label="选择模型" onClick={() => setOpen(true)}>
        <span className="truncate">
          {current ? `${current.entry.name}${level ? ` · ${level}` : ""} · ${current.entry.route.label}` : value ? `${value.model} · ${SOURCE_LABEL[value.source]}` : "选择模型"}
        </span>
        <ChevronsUpDown className="opacity-50" />
      </Button>
      <ModelPickerDialog open={open} onOpenChange={setOpen} value={value} onChange={onChange} authorFamily={authorFamily} title={title} description={description} />
    </>
  );
}

/** The composer's model pill: the model and its level, a menu to change the level, and the full picker. */
export function ModelMenu({ value, onChange, disabled }: { value?: ModelRef; onChange: (model: ChatModel) => void; disabled?: boolean }) {
  const { routes } = useModels();
  const [picking, setPicking] = useState(false);
  const current = entryOf(routes, value);
  const option = current?.option;
  const level = levelText(option, value?.thinking);
  const variant = option?.variant;
  const variants = current && current.entry.options.length > 1 ? current.entry.options : [];
  const sameKind = variants.filter((o) => o.variant?.reasoning === variant?.reasoning && o.variant?.fast === variant?.fast);
  const efforts = [...new Set(sameKind.map((o) => o.variant?.effort))].sort((a, b) => effortRank(a) - effortRank(b));
  const canToggle = (key: "reasoning" | "fast") => variants.some((o) => o.variant?.[key]) && variants.some((o) => !o.variant?.[key]);
  const toVariant = (like: Partial<NonNullable<ModelOption["variant"]>>) => current && onChange(toChatModel({ route: current.entry.route, option: pickVariant(variants, { ...variant, ...like }) }));
  const thinkingOptions = option?.thinking;

  if (!current) {
    return (
      <>
        <Button variant="ghost" size="sm" className="h-7 rounded-full px-2.5 text-xs" disabled={disabled} onClick={() => setPicking(true)} aria-label="回复的模型">
          {value ? value.model : "选择模型"}
          <ChevronDown className="size-3 opacity-60" />
        </Button>
        <ModelPickerDialog open={picking} onOpenChange={setPicking} value={value} onChange={onChange} />
      </>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          aria-label="回复的模型"
          title={`${current.entry.name} · ${current.entry.route.label}`}
          className="inline-flex h-7 max-w-72 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors hover:bg-muted disabled:opacity-50"
        >
          <span className="truncate font-medium">{current.entry.name}</span>
          {level && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground">
              <Sparkles className="size-3" />
              {level}
            </span>
          )}
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="truncate text-xs text-muted-foreground">
            {current.entry.name} · {current.entry.route.label}
          </DropdownMenuLabel>
          {thinkingOptions && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs">思考档位</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={value?.thinking ?? ""} onValueChange={(t) => onChange({ ...toChatModel({ route: current.entry.route, option: option! }), ...(t ? { thinking: t as ThinkingLevel } : {}) })}>
                <DropdownMenuRadioItem value="">默认</DropdownMenuRadioItem>
                {thinkingOptions.map((t) => (
                  <DropdownMenuRadioItem key={t} value={t}>
                    {thinkingLabel(t)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </>
          )}
          {variants.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {efforts.length > 1 && (
                <>
                  <DropdownMenuLabel className="text-xs">档位</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={variant?.effort ?? ""} onValueChange={(e) => toVariant({ effort: e || undefined })}>
                    {efforts.map((e) => (
                      <DropdownMenuRadioItem key={e ?? ""} value={e ?? ""}>
                        {e ? thinkingLabel(e) : "默认"}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </>
              )}
              {canToggle("reasoning") && (
                <DropdownMenuCheckboxItem checked={Boolean(variant?.reasoning)} onCheckedChange={(on) => toVariant({ reasoning: on })}>
                  思考
                </DropdownMenuCheckboxItem>
              )}
              {canToggle("fast") && (
                <DropdownMenuCheckboxItem checked={Boolean(variant?.fast)} onCheckedChange={(on) => toVariant({ fast: on })}>
                  快速
                </DropdownMenuCheckboxItem>
              )}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setPicking(true)}>换模型…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ModelPickerDialog open={picking} onOpenChange={setPicking} value={value} onChange={onChange} />
    </>
  );
}
