import { useState, type ReactNode } from "react";
import { CheckCircle2, Circle, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { useBaton } from "@/lib/store";
import { cn } from "@/lib/utils";

export function Section({ title, description, children, status }: { title: string; description?: ReactNode; children: ReactNode; status?: ReactNode }) {
  return (
    <section className="rounded-xl border p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-medium">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {status}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Which project a management page is showing. */
export function ProjectChip() {
  const { state } = useBaton();
  if (!state) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground" title={state.workspace.root}>
      <FolderOpen className="size-3.5" />
      {state.workspace.name}
    </span>
  );
}

export function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs", ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>
      {ok ? <CheckCircle2 className="size-3.5" /> : <Circle className="size-3.5" />}
      {label}
    </span>
  );
}

export function useBusy() {
  const [busy, setBusy] = useState<string>();
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  return { busy, run };
}
