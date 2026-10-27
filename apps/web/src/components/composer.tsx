import type { ReactNode } from "react";
import { ArrowUp, Loader2 } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import type { ModelRef } from "@/lib/models";
import type { ChatAccess, ChatModel } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AccessMenu } from "./access-menu";
import { ContextRing } from "./context-ring";
import { ModelMenu } from "./model-picker";

/** The chat input: the message, then permission, model and send in one bar, and the chat's facts below it. */
export function Composer({
  text,
  onText,
  onSend,
  sending,
  placeholder,
  label,
  rows = 2,
  autoFocus,
  access,
  onAccess,
  accessDisabled,
  model,
  onModel,
  extra,
  footerLeft,
  cost,
  context,
}: {
  text: string;
  onText: (text: string) => void;
  onSend: () => void;
  sending: boolean;
  placeholder: string;
  label: string;
  rows?: number;
  autoFocus?: boolean;
  access: ChatAccess;
  onAccess: (access: ChatAccess) => void;
  accessDisabled?: boolean;
  model?: ModelRef;
  onModel: (model: ChatModel) => void;
  /** Controls between permission and model, such as the project picker of a new chat. */
  extra?: ReactNode;
  footerLeft?: ReactNode;
  cost?: string;
  context: { used?: number; window?: number; unknown?: string };
}) {
  const canSend = Boolean(text.trim()) && Boolean(model) && !sending;
  return (
    <div>
      <div className="rounded-2xl border bg-card px-3 pt-2.5 pb-2 shadow-sm transition-shadow focus-within:shadow-md focus-within:ring-1 focus-within:ring-ring/30">
        <Textarea
          value={text}
          onChange={(e) => onText(e.target.value)}
          rows={rows}
          autoFocus={autoFocus}
          aria-label={label}
          placeholder={placeholder}
          className="max-h-60 min-h-0 resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
        />
        <div className="mt-1.5 flex items-center gap-1">
          <AccessMenu value={access} onChange={onAccess} disabled={accessDisabled} />
          {extra}
          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            <ModelMenu value={model} onChange={onModel} />
            <button
              type="button"
              aria-label="发送"
              disabled={!canSend}
              onClick={onSend}
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
                canSend ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-muted text-muted-foreground",
              )}
            >
              {sending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
            </button>
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-2 px-2 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1.5 truncate">{footerLeft}</div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {cost && (
            <span className="tabular-nums" title="这个对话的花费">
              {cost}
            </span>
          )}
          {cost && <span className="h-3 w-px bg-border" />}
          <ContextRing used={context.used} window={context.window} unknown={context.unknown} />
        </div>
      </div>
    </div>
  );
}
