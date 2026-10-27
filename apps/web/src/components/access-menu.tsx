import { Check, ChevronDown, Eye, Hand, ShieldAlert, type LucideIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ACCESS } from "@/lib/format";
import type { ChatAccess } from "@/lib/types";
import { cn } from "@/lib/utils";

const LOOK: Record<ChatAccess, { icon: LucideIcon; tone: string }> = {
  read: { icon: Eye, tone: "text-muted-foreground" },
  ask: { icon: Hand, tone: "text-sky-600 dark:text-sky-400" },
  allow: { icon: ShieldAlert, tone: "text-orange-600 dark:text-orange-400" },
};

/** A chat's single permission switch, as a pill; it lasts for this chat until changed or the service restarts. */
export function AccessMenu({ value, onChange, disabled }: { value: ChatAccess; onChange: (access: ChatAccess) => void; disabled?: boolean }) {
  const current = ACCESS.find((a) => a.value === value)!;
  const { icon: Icon, tone } = LOOK[value];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`这个对话的权限：${current.label}`}
        title={disabled ? "回复进行中，结束后再改权限" : current.hint}
        className={cn("inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50", tone)}
      >
        <Icon className="size-3.5" />
        {current.label}
        <ChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-xs text-muted-foreground">这个对话的权限</DropdownMenuLabel>
        {ACCESS.map((a) => {
          const look = LOOK[a.value];
          return (
            <DropdownMenuItem key={a.value} onSelect={() => a.value !== value && onChange(a.value)} className="items-start gap-2 py-2">
              <look.icon className={cn("mt-0.5 size-4", look.tone)} />
              <div className="min-w-0 flex-1">
                <div className={cn("text-sm font-medium", a.value === "allow" && look.tone)}>{a.label}</div>
                <div className="text-xs text-muted-foreground">{a.hint}</div>
              </div>
              {a.value === value && <Check className="mt-0.5 size-4" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
