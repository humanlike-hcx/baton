import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { tokens } from "@/lib/format";
import { cn } from "@/lib/utils";

/** How full the model's context window was after the last reply. `unknown` explains why there is no number. */
export function ContextRing({ used, window, unknown }: { used?: number; window?: number; unknown?: string }) {
  const known = !unknown && window !== undefined && window > 0;
  const ratio = known ? Math.min(1, (used ?? 0) / window) : 0;
  const pct = Math.round(ratio * 100);
  const r = 6.5;
  const length = 2 * Math.PI * r;
  const tone = !known ? "text-muted-foreground/40" : ratio > 0.85 ? "text-destructive" : ratio > 0.6 ? "text-amber-500" : "text-foreground/70";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default items-center gap-1 text-xs tabular-nums text-muted-foreground" aria-label={known ? `上下文已用 ${pct}%` : "上下文用量未知"}>
          <svg viewBox="0 0 16 16" className="size-4 -rotate-90">
            <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" className="stroke-muted" />
            {known && <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" strokeLinecap="round" stroke="currentColor" strokeDasharray={`${ratio * length} ${length}`} className={cn(tone)} />}
          </svg>
          {known ? `${pct}%` : "—"}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        {known ? (
          <>
            上下文 {tokens(used ?? 0)} / {tokens(window)} tokens
            <div className="text-[11px] opacity-80">{used === undefined ? "这个模型还没在这里回复过，回复结束后显示用量。" : "上一次回复结束时的用量。快满时开个新对话，或让它把结论记进记忆。"}</div>
          </>
        ) : (
          unknown
        )}
      </TooltipContent>
    </Tooltip>
  );
}
