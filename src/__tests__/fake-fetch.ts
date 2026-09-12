import type { FetchLike } from "../http.js";

export interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Simulate a hung socket; the SDK's timeout must fire. */
  hang?: boolean;
  /** Simulate a connection failure. */
  throws?: Error;
}

type Handler = (req: Captured, index: number) => Reply;

/** A fetch that records every call and answers from a script. */
export function fakeFetch(handler: Handler): FetchLike & { calls: Captured[] } {
  const calls: Captured[] = [];
  const fn = (async (input, init) => {
    const captured: Captured = {
      url: input,
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(captured);
    const reply = handler(captured, calls.length - 1);
    if (reply.throws) throw reply.throws;
    if (reply.hang) {
      await new Promise<void>((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    const headers = new Map(
      Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return {
      status: reply.status ?? 200,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => (reply.body === undefined ? "" : JSON.stringify(reply.body)),
    };
  }) as FetchLike & { calls: Captured[] };
  fn.calls = calls;
  return fn;
}

export function tokenBody(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    access_token: "at-1",
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: "rt-1",
    refresh_token_expires_at: null,
    scope: "location.verify.zone location.place.current",
    ...overrides,
  };
}
