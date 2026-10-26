const BASE = process.env.BATON_URL ?? "http://127.0.0.1:47321";

/** Calls a baton tool through the local server; the server enforces the same permissions as native tools. */
export async function callTool(tool, args) {
  let res;
  try {
    res = await fetch(`${BASE}/api/bridge/tool`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-baton": "1",
        ...(process.env.BATON_TOKEN ? { "x-baton-token": process.env.BATON_TOKEN } : {}),
      },
      body: JSON.stringify({ tool, args }),
    });
  } catch (error) {
    return { text: `无法连接工作台（${BASE}）：${error.message}`, isError: true };
  }
  const data = await res.json().catch(() => ({ text: `工作台返回了无法解析的响应（HTTP ${res.status}）`, isError: true }));
  if (data.error) return { text: data.error, isError: true };
  return { text: data.text ?? "", isError: Boolean(data.isError) };
}
