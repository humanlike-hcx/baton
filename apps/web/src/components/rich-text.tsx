import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { cn } from "@/lib/utils";

/** GitHub Markdown with TeX math. Raw HTML stays disabled, so model output cannot inject markup. */
export function RichText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("markdown-body text-sm leading-relaxed break-words", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore" }]]}
        components={{
          a({ node: _node, ...props }) {
            return <a {...props} target="_blank" rel="noreferrer noopener" />;
          },
          table({ node: _node, ...props }) {
            return (
              <div className="markdown-table">
                <table {...props} />
              </div>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
