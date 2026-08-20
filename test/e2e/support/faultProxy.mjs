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
 * CORRUPTION modes (the stream keeps flowing but LIES — the harshest class, because the UI
 * keeps reading and must not be poisoned by what it reads):
 *   - duplicate(eventType, n) : emit a matching frame N extra times (at-least-once redelivery)
 *   - reorder(eventType)      : HOLD a matching frame and release it AFTER the next one (out-of-order)
 *   - garbage(afterN)         : inject an unparseable `data:` frame after N frames
 *   - truncate(afterN)        : emit a HALF frame (cut mid-JSON) after N frames
 *   - corruptChecksum(afterN) : rewrite a frame's checksum so the integrity chain breaks
 *   - bogusEvent(afterN)      : inject a well-formed frame with an UNKNOWN event type
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

        /** Frames held back by `reorder`, released after the following frame. */
        let held = null;

        const rawWrite = (text) => { res.write(text); };

        const flushFrame = (frame) => {
          if (killed) return;

          // --- CORRUPTION MODES: the stream keeps flowing but delivers wrong/!well-formed data ---
          if (fault.mode === "duplicate") {
            const t = frameEventType(frame);
            if (t && t === fault.eventType) {
              const extra = fault.n ?? 1;
              if (fault.once !== false) fault = { mode: "none" };
              // Deliver the frame, then re-deliver it N more times: at-least-once redelivery, which
              // a fold that isn't idempotent turns into duplicated messages/tool cards.
              rawWrite(frame + "\n\n");
              for (let i = 0; i < extra; i++) rawWrite(frame + "\n\n");
              forwarded += 1 + extra;
              return;
            }
          }
          if (fault.mode === "reorder") {
            const t = frameEventType(frame);
            if (held === null && t && t === fault.eventType) {
              held = frame; // hold it; the NEXT frame goes first
              return;
            }
            if (held !== null) {
              rawWrite(frame + "\n\n");        // the later frame arrives FIRST
              rawWrite(held + "\n\n");         // then the held one, out of order
              held = null;
              forwarded += 2;
              if (fault.once !== false) fault = { mode: "none" };
              return;
            }
          }
          if (fault.mode === "garbage" && forwarded >= (fault.afterN ?? 1)) {
            if (fault.once !== false) fault = { mode: "none" };
            // An unparseable data: line mid-stream. The client MUST skip it, not die.
            rawWrite("data: {this is not json at all,,,}\n\n");
          }
          if (fault.mode === "truncate" && forwarded >= (fault.afterN ?? 1)) {
            if (fault.once !== false) fault = { mode: "none" };
            // A frame cut mid-JSON with no terminator — a torn write on the wire.
            rawWrite("data: {\"kind\":\"event\",\"event\":{\"type\":\"TEXT_MES");
          }
          if (fault.mode === "bogusEvent" && forwarded >= (fault.afterN ?? 1)) {
            if (fault.once !== false) fault = { mode: "none" };
            // Well-formed JSON, UNKNOWN event type — a newer server talking to an older client.
            rawWrite('data: {"kind":"event","event":{"type":"TOTALLY_UNKNOWN_EVENT","weird":true}}\n\n');
          }
          if (fault.mode === "corruptChecksum" && forwarded >= (fault.afterN ?? 1)) {
            if (fault.once !== false) fault = { mode: "none" };
            // Break the integrity chain: same event, wrong checksum. The client's verification
            // must notice and re-sync from the server rather than render a poisoned fold.
            const bad = frame.replace(/"checksum":"[0-9a-f]+"/, '"checksum":"' + "d".repeat(64) + '"');
            rawWrite(bad + "\n\n");
            forwarded += 1;
            return;
          }

          if (fault.mode === "drop") {
            const t = frameEventType(frame);
            if (t && t === fault.eventType) {
              // ONE-SHOT by default: drop the FIRST matching frame, then DISARM so
              // the reconnect's re-fetch of the persisted log (which HAS this frame)
              // gets it and the UI heals. This models a single LIVE frame being lost
              // — not a server that permanently omits it. `once:false` drops every
              // occurrence (a harsher, rarely-needed variant).
              if (fault.once !== false) fault = { mode: "none" };
              return; // omit this occurrence
            }
          }
          res.write(frame + "\n\n");
          forwarded += 1;
          if (fault.mode === "killAfter" && forwarded >= (fault.n ?? 1)) {
            killed = true;
            // ONE-SHOT: disarm so the UI's reconnect gets a clean stream and the
            // turn can actually complete (the point is to prove recovery, not to
            // wedge every connection forever).
            fault = { mode: "none" };
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
