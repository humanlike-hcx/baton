export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? "GET",
      headers: { "content-type": "application/json", "x-workbench": "1" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError("连不上本地服务。确认 `pnpm dev` 还在运行。", 0);
  }
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    if (!res.ok) throw new ApiError(text || `请求失败（HTTP ${res.status}）`, res.status);
  }
  if (!res.ok) {
    const message = (data as { error?: string } | undefined)?.error ?? `请求失败（HTTP ${res.status}）`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body ?? {} });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: "PUT", body });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });
