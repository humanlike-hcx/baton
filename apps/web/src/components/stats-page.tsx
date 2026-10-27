import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { familyLabel } from "@baton/core/families";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { RUNTIME_LABEL, SOURCE_LABEL, tokens } from "@/lib/format";
import type { StatRow } from "@/lib/types";

const USD_TO_CNY = 7.2;

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
              按「运行时 + 模型」统计：回复成功了多少、改过多少次文件、它的改动被别的模型检查时通过了多少，以及它替别人做了多少次检查。用这些数字决定平时用谁。
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw /> 刷新
          </Button>
        </div>

        {error && <p className="mt-6 text-sm text-destructive">{error}</p>}
        {!rows && !error && <Skeleton className="mt-6 h-40 w-full rounded-xl" />}
        {rows && rows.length === 0 && <div className="mt-6 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">还没有运行记录。聊过几轮之后这里会出现每个模型的表现。</div>}

        {sorted.length > 0 && (
          <div className="mt-6 overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">模型</th>
                  <th className="px-3 py-2 text-right font-medium">运行</th>
                  <th className="px-3 py-2 text-right font-medium">成功 / 失败</th>
                  <th className="px-3 py-2 text-right font-medium">改了文件</th>
                  <th className="px-3 py-2 text-right font-medium" title="它的改动被别的模型检查的结果">被检查：通过 / 不通过</th>
                  <th className="px-3 py-2 text-right font-medium">替别人检查</th>
                  <th className="px-3 py-2 text-right font-medium">tokens</th>
                  <th className="px-3 py-2 text-right font-medium">花费</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {sorted.map((r) => (
                  <tr key={r.key}>
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs">{r.model}</div>
                      <div className="text-xs text-muted-foreground">
                        {SOURCE_LABEL[r.source]} · {RUNTIME_LABEL[r.runtime] ?? r.runtime} · {familyLabel(r.family)}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.runs}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.succeeded} / {r.failed}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.changes}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.reviewedPass + r.reviewedFail ? `${r.reviewedPass} / ${r.reviewedFail}（${pct(r.reviewedPass, r.reviewedPass + r.reviewedFail)}）` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.reviewsGiven || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{tokens(r.tokens)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.source === "deepseek" ? `¥${(r.costUsd * USD_TO_CNY).toFixed(2)}` : r.source === "demo" ? "免费" : "订阅内"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">ChatGPT 和 Cursor 走订阅，不按 token 计费；DeepSeek 按 API 实际花费换算成人民币。</p>
      </div>
    </div>
  );
}
