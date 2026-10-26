import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { familyLabel } from "@baton/core/families";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { RUNTIME_LABEL, STAGE_LABEL, tokens } from "@/lib/format";
import type { Stage, StatRow } from "@/lib/types";

const USD_TO_CNY = 7.2;
const STAGES: Stage[] = ["plan", "implement", "review"];

function pct(n: number, d: number): string {
  return d ? `${Math.round((n / d) * 100)}%` : "—";
}

export function StatsPage() {
  const [rows, setRows] = useState<StatRow[]>();
  const [error, setError] = useState<string>();

  const load = async () => {
    try {
      setRows(await api<StatRow[]>("/api/stats"));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const sorted = [...(rows ?? [])].sort((a, b) => b.runs - a.runs);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">统计</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              按「运行时 + 模型」统计，而不是笼统按厂商。用这些数字调整路由：谁实现一次过的多、谁总被退回、谁花钱最多。
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw /> 刷新
          </Button>
        </div>

        {error && <p className="mt-6 text-sm text-destructive">{error}</p>}
        {!rows && !error && <Skeleton className="mt-6 h-40 w-full rounded-xl" />}
        {rows && rows.length === 0 && <div className="mt-6 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">还没有运行记录。跑完一个线程后这里会出现每个模型的表现。</div>}

        {sorted.length > 0 && (
          <div className="mt-6 overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">运行时 · 模型</th>
                  <th className="px-3 py-2 text-right font-medium">运行</th>
                  {STAGES.map((s) => (
                    <th key={s} className="px-3 py-2 text-right font-medium">
                      {STAGE_LABEL[s]}成功
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium">实现一次过</th>
                  <th className="px-3 py-2 text-right font-medium">被退回</th>
                  <th className="px-3 py-2 text-right font-medium">你采纳/拒绝</th>
                  <th className="px-3 py-2 text-right font-medium">tokens</th>
                  <th className="px-3 py-2 text-right font-medium">花费</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {sorted.map((r) => {
                  const impl = r.stages.implement;
                  return (
                    <tr key={r.key}>
                      <td className="px-3 py-2">
                        <div className="font-mono text-xs">{r.model}</div>
                        <div className="text-xs text-muted-foreground">
                          {RUNTIME_LABEL[r.runtime as "pi" | "cursor"] ?? r.runtime} · {familyLabel(r.family)} · {r.agentIds.join(", ")}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.runs}</td>
                      {STAGES.map((s) => {
                        const st = r.stages[s];
                        return (
                          <td key={s} className="px-3 py-2 text-right tabular-nums">
                            {st ? `${st.succeeded}/${st.runs}` : "—"}
                          </td>
                        );
                      })}
                      <td className="px-3 py-2 text-right tabular-nums">{impl ? pct(impl.firstPass, impl.runs) : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{impl ? impl.sentBack : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.accepted}/{r.declined}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{tokens(r.tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.costUsd > 0 ? `¥${(r.costUsd * USD_TO_CNY).toFixed(2)}` : "订阅内"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">ChatGPT 和 Cursor 走订阅，按次数计入额度；DeepSeek 按 API 实际花费换算成人民币。</p>
      </div>
    </div>
  );
}
