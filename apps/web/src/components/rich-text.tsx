import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

function inline(text: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/** Small Markdown subset: headings, bullets, bold, inline code, line breaks. */
export function RichText({ text, className }: { text: string; className?: string }) {
  const lines = text.split("\n");
  return (
    <div className={cn("space-y-1 text-sm leading-relaxed break-words", className)}>
      {lines.map((line, i) => {
        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) return <div key={i} className="pt-1 font-semibold">{inline(heading[2]!)}</div>;
        const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
        if (bullet) {
          return (
            <div key={i} className="flex gap-2" style={{ paddingLeft: `${bullet[1]!.length * 6}px` }}>
              <span className="text-muted-foreground">•</span>
              <span className="min-w-0">{inline(bullet[2]!)}</span>
            </div>
          );
        }
        const numbered = /^(\d+)\.\s+(.*)$/.exec(line);
        if (numbered) {
          return (
            <div key={i} className="flex gap-2">
              <span className="text-muted-foreground tabular-nums">{numbered[1]}.</span>
              <span className="min-w-0">{inline(numbered[2]!)}</span>
            </div>
          );
        }
        if (!line.trim()) return <div key={i} className="h-1" />;
        return <div key={i}>{inline(line)}</div>;
      })}
    </div>
  );
}
