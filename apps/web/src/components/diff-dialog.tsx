import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export function DiffDialog({ runId, title, onOpenChange }: { runId?: string; title?: string; onOpenChange: (open: boolean) => void }) {
  const [diff, setDiff] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!runId) return;
    setDiff(undefined);
    setError(undefined);
    api<{ diff: string }>(`/api/runs/${runId}/diff`)
      .then((r) => setDiff(r.diff))
      .catch((e: Error) => setError(e.message));
  }, [runId]);
  return (
    <Dialog open={Boolean(runId)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>这次运行的改动</DialogTitle>
          <DialogDescription>{title ?? "运行前后两次快照之间的差异（影子 Git，不碰你自己的 .git）"}</DialogDescription>
        </DialogHeader>
        <div className="min-h-40 overflow-auto rounded-md border bg-muted/30">
          {!diff && !error && (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> 正在读取…
            </div>
          )}
          {error && <p className="p-4 text-sm text-destructive">{error}</p>}
          {diff !== undefined && !diff.trim() && <p className="p-4 text-sm text-muted-foreground">这次运行没有改动文件。</p>}
          {diff && (
            <pre className="p-3 font-mono text-xs leading-5">
              {diff.split("\n").map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    "whitespace-pre-wrap break-all",
                    line.startsWith("+") && !line.startsWith("+++") && "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
                    line.startsWith("-") && !line.startsWith("---") && "bg-red-500/10 text-red-800 dark:text-red-300",
                    line.startsWith("@@") && "text-sky-700 dark:text-sky-300",
                    line.startsWith("diff ") && "mt-2 font-semibold",
                  )}
                >
                  {line || " "}
                </div>
              ))}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
