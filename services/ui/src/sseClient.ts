// The SSE loop every UI push stream shares: reconnect, watchdog, parse.

export interface SSEHandlers<F> {
  onFrame(frame: F): void;
  /** The body is being read; each reconnect calls it again. */
  onOpen?(): void;
  /** Called before each reconnect wait. */
  onDown?(): void;
}

export interface SSEOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  /** Silence after which the socket is presumed dead. */
  staleAfterMs?: number;
  /** First retry wait after a non-OK response; doubles up to maxRetryMs. */
  retryAfterMs?: number;
  maxRetryMs?: number;
  reconnectAfterMs?: number;
  label?: string;
}

export interface SSESubscription {
  close(): void;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Open `url` as a stream of JSON frames, reconnecting until closed. */
export function openSSE<F>(url: string, handlers: SSEHandlers<F>, opts: SSEOptions = {}): SSESubscription {
  const doFetch = opts.fetchImpl ?? fetch;
  // Servers heartbeat every 25s, so longer silence is a dead socket.
  const staleAfterMs = opts.staleAfterMs ?? 60_000;
  const retryAfterMs = opts.retryAfterMs ?? 1000;
  const maxRetryMs = opts.maxRetryMs ?? 30_000;
  const reconnectAfterMs = opts.reconnectAfterMs ?? 500;
  const label = opts.label ?? "sse";

  let closed = false;
  let controller: AbortController | undefined;
  let refusals = 0;

  // Aborting surfaces as a read error, which the loop reconnects.
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = (c: AbortController) => {
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = setTimeout(() => c.abort(), staleAfterMs);
  };
  const disarmWatchdog = () => {
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = undefined;
  };

  const run = async () => {
    while (!closed) {
      const c = new AbortController();
      controller = c;
      // Armed before the fetch: a hung connect is dead too.
      armWatchdog(c);
      let wait = reconnectAfterMs;
      try {
        const res = await doFetch(url, {
          headers: {
            Accept: "text/event-stream",
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          },
          // Firefox makes identical stored GETs wait on a never-ending stream.
          cache: "no-store",
          credentials: "same-origin",
          signal: c.signal,
        });
        if (!res.ok || !res.body) {
          wait = Math.min(maxRetryMs, retryAfterMs * 2 ** refusals++);
          throw new Error(`HTTP ${res.status}`);
        }
        refusals = 0;
        handlers.onOpen?.();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          // Any byte counts, heartbeat comments included.
          armWatchdog(c);
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = raw.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            let frame: F;
            try {
              frame = JSON.parse(line.slice(5).trim()) as F;
            } catch (e) {
              console.warn(`[${label}] dropping unparseable frame:`, line.slice(0, 200), e);
              continue;
            }
            handlers.onFrame(frame);
          }
        }
      } catch {
        // Drop, watchdog abort, refusal or close(): reconnect unless closed.
      }
      disarmWatchdog();
      if (closed) break;
      handlers.onDown?.();
      await delay(wait);
    }
  };

  void run();

  return {
    close() {
      closed = true;
      disarmWatchdog();
      controller?.abort();
    },
  };
}
