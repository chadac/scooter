/**
 * SSE FAULT PROXY — a tiny HTTP proxy the UI dev server proxies to instead of the
 * agent-host, so Tier-3 e2e can SIMULATE stream failures the browser can't inject
 * itself (Playwright route interception is request/response-level, not
 * SSE-chunk-level).
 *
 * It forwards every request to the real agent-host, but on the conversation
 * INTEGRITY stream (`…/events.integrity`) it can, per the current fault config:
 *   - drop(eventType) : omit matching `data:` event frames from the forwarded body
 *   - stall(stallMs)  : pause forwarding once for stallMs, then resume (slow delivery)
 *   - killAfter(n)    : close the connection after N frames (forces a reconnect)
 *   - authExpire      : respond 401 (an expired ingress/auth session in front)
 *
 * Faults are set out-of-band by the test via `POST /__fault` (JSON body) and
 * apply to the NEXT integrity connection(s). `POST /__fault {mode:"none"}` clears.
 * Everything else (POST /agui, /conversations, /tail, …) passes straight through,
 * so a normal turn still works — the fault is scoped to the live stream.
 *
 * Plain .mjs (no TS toolchain) so it runs as a bare `node` webServer command.
 * Env: FAULT_PROXY_PORT (default 8090), AGENT_HOST_PORT (default 8080).
 */

import http from "node:http";

const INTEGRITY_RE = /\/events\.integrity(\?|$)/;

/** Parse one SSE frame's inner event type (best-effort). */
function frameEventType(frame) {
  const line = frame.split("\n").find((l) => l.startsWith("data:"));
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line.slice(5).trim());
    return parsed?.event?.type;
  } catch {
    return undefined;
  }
}

export function startFaultProxy({ port, targetHost, targetPort }) {
  /** @type {{mode:string, eventType?:string, stallMs?:number, n?:number}} */
  let fault = { mode: "none" };

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";

    // Control channel: set/clear the active fault.
    if (url === "/__fault" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          fault = body ? JSON.parse(body) : { mode: "none" };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, fault }));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      });
      return;
    }

    const isIntegrity = INTEGRITY_RE.test(url);

    // authExpire: an expired ingress/auth session in front returns 401 for the
    // stream (the "requests suddenly fail" case) instead of proxying.
    if (isIntegrity && fault.mode === "authExpire") {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("Unauthorized (session expired)");
      return;
    }

    const proxyReq = http.request(
      { host: targetHost, port: targetPort, method: req.method, path: url, headers: req.headers },
      (proxyRes) => {
        if (!isIntegrity || fault.mode === "none") {
          res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
          proxyRes.pipe(res);
          return;
        }

        // Integrity stream with a fault: re-frame the SSE body so we can drop /
        // stall / kill at frame boundaries.
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        let buf = "";
        let forwarded = 0;
        let stalled = false;
        let killed = false;

        const flushFrame = (frame) => {
          if (killed) return;
          if (fault.mode === "drop") {
            const t = frameEventType(frame);
            if (t && t === fault.eventType) return; // omit this frame
          }
          res.write(frame + "\n\n");
          forwarded += 1;
          if (fault.mode === "killAfter" && forwarded >= (fault.n ?? 1)) {
            killed = true;
            proxyRes.destroy(); // abrupt close → the UI must reconnect + re-fold
            res.end();
          }
        };

        const drain = () => {
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (frame.trim()) flushFrame(frame);
          }
        };

        proxyRes.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          // stall: hold the WHOLE stream once for stallMs, then resume.
          if (fault.mode === "stall" && !stalled) {
            stalled = true;
            setTimeout(drain, fault.stallMs ?? 1000);
            return;
          }
          if (!stalled || fault.mode !== "stall") drain();
        });
        proxyRes.on("end", () => { if (!killed) res.end(); });
        proxyRes.on("error", () => { if (!killed) res.end(); });
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(proxyReq);
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

const port = Number(process.env.FAULT_PROXY_PORT ?? 8090);
const targetPort = Number(process.env.AGENT_HOST_PORT ?? 8080);
startFaultProxy({ port, targetHost: "127.0.0.1", targetPort }).then(() => {
  // eslint-disable-next-line no-console
  console.log(`[fault-proxy] listening on ${port} -> 127.0.0.1:${targetPort}`);
});
