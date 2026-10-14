/** Sunucudan dönen kullanıcıya gösterilebilir hata. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const isRaw = body instanceof Blob;
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: isRaw ? { 'Content-Type': (body as Blob).type || 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: isRaw ? (body as Blob) : body !== undefined ? JSON.stringify(body) : undefined,
    ...init,
  });
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json().catch(() => ({})) : {};
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('kesit:unauthorized'));
    throw new ApiError(res.status, (data as { error?: string }).error || `İstek başarısız (${res.status})`, data);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  del: <T>(url: string) => request<T>('DELETE', url),
  /** Dosyayı ham gövde olarak yükler (sunucu diske akıtır). */
  upload: <T>(url: string, file: File) => request<T>('POST', url, file),
};

export function query(params: Record<string, string | number | boolean | null | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}
