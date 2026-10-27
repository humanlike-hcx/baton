import { ACCESS } from "@/lib/format";
import type { ChatAccess } from "@/lib/types";
import { cn } from "@/lib/utils";

/** A chat's single permission switch; it lasts for this chat until changed or the service restarts. */
export function AccessSwitch({ value, onChange, disabled }: { value: ChatAccess; onChange: (access: ChatAccess) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="这个对话的权限" className="inline-flex rounded-md border p-0.5 text-xs">
      {ACCESS.map((a) => (
        <button
          key={a.value}
          type="button"
          role="radio"
          aria-checked={value === a.value}
          title={a.hint}
          disabled={disabled}
          onClick={() => value !== a.value && onChange(a.value)}
          className={cn(
            "rounded px-2 py-1 transition-colors disabled:opacity-50",
            value === a.value
              ? a.value === "allow"
                ? "bg-amber-500/15 font-medium text-amber-800 dark:text-amber-200"
                : "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
