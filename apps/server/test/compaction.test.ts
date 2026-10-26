import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testServer } from "./helpers.ts";

describe("HTTP API: in-run compaction keeps the handoff whole (US-41)", () => {
  it("syncs the compaction summary into the handoff draft and fills what the handoff left out", async () => {
    const s = await testServer({ settings: (st) => (st.confirm.planToImplement = false) });
    const created = await s.post("/api/threads", { title: "长任务", task: "写一份说明，任务很长，中途会压缩上下文", acceptance: ["有说明"], stage: "implement" });
    const t = await s.settled(created.id);

    const impl = t.runs.find((r) => r.stage === "implement")!;
    const note = impl.changedFiles.find((f) => f.startsWith("notes/"))!;
    expect(note).toBeDefined();
    expect(impl.progress?.compactions).toBeGreaterThanOrEqual(1);
    expect(impl.progress?.done.join("\n")).toContain(`创建了 ${note}`);
    expect(t.items.some((i) => i.kind === "notice" && i.text.includes("已同步到交接草稿"))).toBe(true);

    // The agent's own handoff only remembered the last step; the summary supplies the rest.
    const h = impl.handoff!;
    expect(h.auto).toBe(false);
    expect(h.done).toContain(`确认了 ${note} 的行数`);
    expect(h.done).toContain("压缩前的进展");
    expect(h.done).toContain(`创建了 ${note}`);
    const file = fs.readFileSync(path.join(s.root, ".baton/handoffs", t.id, `${impl.id}.md`), "utf8");
    expect(file).toContain(`创建了 ${note}`);

    // The next agent starts from the merged handoff.
    const review = t.runs.find((r) => r.stage === "review")!;
    const briefing = fs.readFileSync(path.join(s.root, ".baton/sessions/briefings", `${review.id}.md`), "utf8");
    expect(briefing).toContain(`创建了 ${note}`);
  });

  it("leaves runs that never compact untouched", async () => {
    const s = await testServer({ settings: (st) => (st.confirm.planToImplement = false) });
    const created = await s.post("/api/threads", { title: "短任务", task: "写一份说明", acceptance: ["有说明"], stage: "implement" });
    const t = await s.settled(created.id);
    const impl = t.runs.find((r) => r.stage === "implement")!;
    expect(impl.progress).toBeUndefined();
    expect(impl.handoff?.done).not.toContain("压缩前的进展");
  });
});
