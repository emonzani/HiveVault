// HTTP client of the web app: same-origin cookies, CSRF header on writes, Italian error messages.
import { t } from "./i18n.ts";

export interface ApiErrorBody {
  error?: { code?: string; message?: string } | string;
  message?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let csrf: string | null = null;
let onUnauthenticated: (() => void) | null = null;

export function setCsrf(token: string | null): void {
  csrf = token;
}

/** Called when a request answers 401 (session expired or revoked). */
export function setUnauthenticatedHandler(fn: () => void): void {
  onUnauthenticated = fn;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: ApiErrorBody = {};
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    /* not JSON */
  }
  const e = typeof body.error === "object" ? body.error : { code: body.error, message: body.message };
  const fallback = res.status >= 500 ? t("Errore del server. Riprova tra poco.") : t("Richiesta non riuscita ({status}).", { status: res.status });
  return new ApiError(res.status, e?.code ?? String(res.status), e?.message ?? fallback);
}

export async function request<T>(method: string, url: string, body?: unknown, o: { signal?: AbortSignal; quiet401?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined && !(body instanceof FormData)) headers["content-type"] = "application/json";
  if (method !== "GET" && csrf) headers["x-cb-csrf"] = csrf;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: "same-origin",
      ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      ...(o.signal ? { signal: o.signal } : {}),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "network", t("Il server non risponde. Controlla la connessione."));
  }
  if (!res.ok) {
    const err = await parseError(res);
    if (res.status === 401 && !o.quiet401) onUnauthenticated?.();
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("json") ? await res.json() : await res.text()) as T;
}

export const api = {
  get: <T>(url: string, o?: { signal?: AbortSignal; quiet401?: boolean }) => request<T>("GET", url, undefined, o),
  post: <T>(url: string, body?: unknown, o?: { signal?: AbortSignal; quiet401?: boolean }) => request<T>("POST", url, body ?? {}, o),
  put: <T>(url: string, body: unknown) => request<T>("PUT", url, body),
  del: <T>(url: string) => request<T>("DELETE", url),
};

export const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** Upload with progress (fetch has no upload progress): resolves with the JSON answer. */
export function upload<T>(url: string, form: FormData, onProgress: (loaded: number, total: number) => void): { promise: Promise<T>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open("POST", url);
    if (csrf) xhr.setRequestHeader("x-cb-csrf", csrf);
    xhr.setRequestHeader("accept", "application/json");
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : 0);
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else {
        const b = (body ?? {}) as ApiErrorBody;
        const e = typeof b.error === "object" ? b.error : { code: b.error, message: b.message };
        reject(new ApiError(xhr.status, e?.code ?? String(xhr.status), e?.message ?? t("Caricamento non riuscito ({status}).", { status: xhr.status })));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "network", t("Il server non risponde. Controlla la connessione.")));
    xhr.onabort = () => reject(new ApiError(0, "aborted", t("Caricamento annullato.")));
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}
