import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RichText } from "../src/components/rich-text";

const render = (text: string) => renderToStaticMarkup(<RichText text={text} />);

describe("rich text rendering", () => {
  it("renders GitHub Markdown instead of showing its syntax", () => {
    const html = render(
      ["## 标题", "", "| A | B |", "|---|---|", "| 1 | 2 |", "", "~~旧~~ **新** [链接](https://example.com)", "", "- [x] 完成"].join("\n"),
    );
    expect(html).toContain("<h2>标题</h2>");
    expect(html).toContain("<table>");
    expect(html).toContain("<del>旧</del>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('type="checkbox"');
  });

  it("renders inline and block TeX with KaTeX", () => {
    const html = render(["行内公式 $E=mc^2$", "", "$$", "\\frac{a}{b}", "$$"].join("\n"));
    expect(html.match(/class="katex"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("katex-display");
  });

  it("keeps code blocks literal and raw HTML inert", () => {
    const html = render(["```tex", "$x^2$", "```", "", '<img src=x onerror="alert(1)">'].join("\n"));
    expect(html).toContain("$x^2$");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
