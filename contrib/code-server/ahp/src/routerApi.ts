import { readFileSync } from "node:fs";
import type { AguiEvent, ChildSession, ScooterApi, SessionsApi } from "./scooterBackend.js";
import { MESSAGE_SOURCE, RouterRefused } from "./conversationView.js";

function check(res: Response, what: string): void {
  if (res.status === 403 || res.status === 404) throw new RouterRefused(res.status, what);
  if (!res.ok || !res.body) throw new Error(`${what}: ${res.status}`);
}

/** The conversation-router's sandbox self-access API, authenticated as this pod (see conversation-router/selfaccess.go). */
export function routerApi(baseUrl: string, conversationId: string, tokenPath?: string): SessionsApi {
  const root = `${baseUrl.replace(/\/$/, "")}/conversations/`;
  const urlOf = (id: string) => root + encodeURIComponent(id);
  // Re-read per call: the projected token rotates on disk.
  const headers = (): Record<string, string> =>
    tokenPath ? { authorization: `Bearer ${readFileSync(tokenPath, "utf8").trim()}` } : {};
  const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const res = await fetch(url, { ...init, headers: { ...headers(), ...(init.body ? { "content-type": "application/json" } : {}) } });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => "")).trim()}`.trim());
    return res;
  };
  const post = (url: string, body?: unknown) => request(url, { method: "POST", body: JSON.stringify(body ?? {}) });
  const sessions = `${urlOf(conversationId)}/sessions`;
  return {
    async create(titlePrefix) {
      return (await (await post(sessions, { titlePrefix })).json()) as ChildSession;
    },
    async list() {
      return ((await (await request(sessions)).json()) as { sessions: ChildSession[] }).sessions;
    },
    async end(id) {
      await post(`${urlOf(id)}/suspend`);
    },
    conversation: (id) => conversationApi(urlOf(id), headers, post),
  };
}

function conversationApi(base: string, headers: () => Record<string, string>, post: (url: string, body?: unknown) => Promise<Response>): ScooterApi {
  return {
    sendMessage: async (text) => { await post(`${base}/messages`, { text, source: MESSAGE_SOURCE }); },
    cancel: async () => { await post(`${base}/cancel`); },
    async stream(onEvent, signal) {
      // /events only replays; live events reach a persistent viewer through /events.integrity.
      // Subscribe first so nothing appended while /history is read is missed, then link the
      // two by checksum: history ends at checksum H, live frames continue from H.
      const res = await fetch(`${base}/events.integrity`, { headers: { ...headers(), accept: "text/event-stream" }, signal });
      check(res, "events.integrity");
      const frames = sseData(res.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
      const first = frames.next(); // start reading so the subscription is live before /history
      const hist = await fetch(`${base}/history`, { headers: headers(), signal });
      check(hist, "history");
      const { events, checksum } = (await hist.json()) as { events: AguiEvent[]; checksum: string };
      for (const e of events) onEvent(e);
      const link = linker(checksum);
      for (let n = await first; !n.done; n = await frames.next()) {
        let frame: IntegrityFrame;
        try { frame = JSON.parse(n.value) as IntegrityFrame; } catch { continue; }
        const ev = link(frame);
        if (ev) onEvent(ev);
      }
    },
  };
}

export interface IntegrityFrame { kind: string; event?: AguiEvent; checksum?: string; prevChecksum?: string }

/**
 * Picks the live events that follow a history ending at checksum `head`. The integrity
 * stream first replays (a snapshot plus unchecksummed frames, and checksummed ones already
 * in /history); those never link to `head` and are dropped. Once a frame links, every later
 * one must too: a gap throws so the caller reconnects and re-reads history.
 */
export function linker(head: string): (f: IntegrityFrame) => AguiEvent | undefined {
  let running = head;
  let linked = false;
  return (f) => {
    if (f.kind !== "event" || !f.event || !f.checksum) return undefined;
    if (f.prevChecksum === running) {
      linked = true;
      running = f.checksum;
      return f.event;
    }
    if (linked) throw new Error("events.integrity: checksum gap");
    return undefined; // already covered by /history
  };
}

/** Yields the `data:` payload of each SSE frame. */
export async function* sseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) yield data;
    }
  }
}
