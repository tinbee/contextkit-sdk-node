import {
  ApiError,
  NetworkError,
  NotFoundError,
  RateLimitedError,
  ScopeError,
  TimeoutError,
  ValidationError,
} from "./errors.js";

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface HttpOptions {
  fetchImpl: FetchLike;
  timeoutMs: number;
  userAgent: string;
}

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** 401 handling is the caller's job (it needs to refresh); everything
   *  else is mapped here. */
  query?: Record<string, string | number | undefined>;
}

export interface HttpResponse<T> {
  status: number;
  data: T;
  headers: { get(name: string): string | null };
}

/** Thrown for 401 only, so the auth layer can decide whether to refresh. */
export class UnauthorizedSignal extends Error {
  readonly body: unknown;
  constructor(body: unknown) {
    super("unauthorized");
    this.body = body;
  }
}

export async function request<T>(opts: HttpOptions, req: HttpRequest): Promise<HttpResponse<T>> {
  const url = withQuery(req.url, req.query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  let status: number;
  let text: string;
  let headers: { get(name: string): string | null };
  try {
    const res = await opts.fetchImpl(url, {
      method: req.method,
      headers: {
        "accept": "application/json",
        "user-agent": opts.userAgent,
        ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(req.headers ?? {}),
      },
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      signal: controller.signal,
    });
    status = res.status;
    headers = res.headers;
    text = await res.text();
  } catch (err) {
    if (controller.signal.aborted) throw new TimeoutError(url, opts.timeoutMs);
    throw new NetworkError(url, err);
  } finally {
    clearTimeout(timer);
  }

  const data = parseJson(text);
  if (status >= 200 && status < 300) return { status, data: data as T, headers };

  const message = errorMessage(data, status);
  switch (status) {
    case 400:
      throw new ValidationError(errorMessages(data), data);
    case 401:
      throw new UnauthorizedSignal(data);
    case 403:
      throw new ScopeError(message, data);
    case 404:
      throw new NotFoundError(message, data);
    case 429:
      throw new RateLimitedError(message, retryAfter(headers.get("retry-after")), data);
    default:
      throw new ApiError(message, status, data);
  }
}

function withQuery(url: string, query: HttpRequest["query"]): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Nest's default error body is { statusCode, message: string | string[], error }. */
function errorMessages(data: unknown): string[] {
  if (data && typeof data === "object" && "message" in data) {
    const m = (data as { message: unknown }).message;
    if (Array.isArray(m)) return m.map(String);
    if (typeof m === "string") return [m];
  }
  return [];
}

function errorMessage(data: unknown, status: number): string {
  const messages = errorMessages(data);
  return messages.length ? messages.join("; ") : `HTTP ${status}`;
}

function retryAfter(header: string | null): number | null {
  if (!header) return null;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
