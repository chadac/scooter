/**
 * The `/contrib-api` relays: a contrib's UI reaches its contrib's broker half as the
 * signed-in user, either for itself (settings tabs) or for one conversation (panels).
 *
 *   browser ── /contrib-api/<name>/<rest> ──▶ agent-host ── <brokerPrefix>/user/<rest> ──▶ broker
 *   browser ── /conversations/<id>/contrib-api/<name>/<rest>
 *           ──▶ agent-host ── <brokerPrefix>/conversation/<sandboxKey>/<rest> ──▶ broker
 *
 * The conversation form sits under /conversations/:id, so the management API's access
 * guard has already refused a caller who may not see that conversation.
 *
 * The agent-host is the only service that knows who the browser user is, so it names
 * them in X-Scooter-User on a request it signs with its own service-account token. The
 * broker trusts that header only from the agent-host's account (USER_RELAY_SERVICE_ACCOUNTS),
 * and the relay builds its outgoing headers from scratch, so nothing the browser sends,
 * a forged X-Scooter-User included, reaches the broker.
 */

import type { IncomingMessage } from "node:http";

import type { Ctx, Router } from "../http/router.js";
import { logger } from "../log.js";

const log = logger("agent-host");

/** The header the broker reads the relayed user from. */
export const RELAYED_USER_HEADER = "X-Scooter-User";

/** One contrib whose tab opted into the relay, from CONTRIB_USER_API_JSON. */
export interface ContribUserApi {
  /** Where the contrib's broker routes are mounted, e.g. "/personalization". */
  brokerPrefix: string;
}

export interface ContribApiDeps {
  /** Contrib name -> its broker prefix; a contrib not listed here gets 404. */
  contribs: Record<string, ContribUserApi>;
  /** The broker's base URL; empty means no broker, and every call answers 503. */
  brokerUrl: string;
  /** The agent-host's own broker auth headers (its SA token). */
  authHeaders: () => Promise<Record<string, string>>;
  /** A conversation id or sandbox key -> the broker's key for it; null when unknown. */
  conversationKey?: (id: string) => Promise<string | null>;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

/** Parse CONTRIB_USER_API_JSON; unset or malformed means no contrib has a relay. */
export function parseContribUserApi(raw: string | undefined): Record<string, ContribUserApi> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, ContribUserApi> = {};
    for (const [name, cfg] of Object.entries(parsed as Record<string, unknown>)) {
      const prefix = (cfg as { brokerPrefix?: unknown } | null)?.brokerPrefix;
      if (typeof prefix === "string" && prefix.startsWith("/")) out[name] = { brokerPrefix: prefix };
    }
    return out;
  } catch (e) {
    log.errorWith("CONTRIB_USER_API_JSON is not valid JSON; no contrib settings API is relayed", e as Error);
    return {};
  }
}

// Bodies are small JSON documents (a profile, a list of notes); anything bigger is a
// misuse of a settings tab.
const MAX_BODY_BYTES = 1024 * 1024;

const readRaw = (req: IncomingMessage): Promise<Buffer | null> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer | string) => {
      const b = typeof c === "string" ? Buffer.from(c) : c;
      size += b.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        return;
      }
      parts.push(b);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Mount `/contrib-api/:contrib/*` and `/conversations/:id/contrib-api/:contrib/*` on `r`. */
export function mountContribApi(r: Router, deps: ContribApiDeps): void {
  const doFetch = deps.fetch ?? fetch;
  const brokerUrl = deps.brokerUrl.replace(/\/$/, "");

  // `subtree` is the broker path under the contrib's prefix; null means 404.
  const relayTo = (subtree: (ctx: Ctx) => Promise<string | null>) => async (ctx: Ctx) => {
    if (ctx.user.anonymous) return { status: 401, json: { error: "sign in first" } };
    const name = ctx.params.contrib;
    const cfg = Object.hasOwn(deps.contribs, name) ? deps.contribs[name] : undefined;
    if (!cfg) return { status: 404, json: { error: `no settings API for contrib '${name}'` } };
    if (!brokerUrl) return { status: 503, json: { error: "the broker is not configured" } };

    // `..` and `.` are refused rather than normalised, so a path can never climb out of
    // the contrib's /user/ subtree on the broker.
    const rest = ctx.params["*"];
    const unsafe = (s: string) => {
      try {
        const d = decodeURIComponent(s);
        return d === "" || d === "." || d === ".." || d.includes("/") || d.includes("\\");
      } catch {
        return true;
      }
    };
    if (rest.split("/").some(unsafe)) {
      return { status: 400, json: { error: "invalid path" } };
    }

    const method = ctx.req.method ?? "GET";
    const body = method === "GET" || method === "DELETE" ? undefined : await readRaw(ctx.req);
    if (body === null) return { status: 413, json: { error: "request body too large" } };

    const headers: Record<string, string> = { ...(await deps.authHeaders()) };
    const contentType = ctx.req.headers["content-type"];
    if (typeof contentType === "string") headers["Content-Type"] = contentType;
    else if (!body?.length) delete headers["Content-Type"];
    headers[RELAYED_USER_HEADER] = ctx.user.id;

    const base = await subtree(ctx);
    if (base === null) return { status: 404, json: { error: "not found" } };
    const query = ctx.query.toString();
    const url = `${brokerUrl}${cfg.brokerPrefix.replace(/\/$/, "")}/${base}/${rest}${query ? `?${query}` : ""}`;
    let res: Response;
    try {
      res = await doFetch(url, { method, headers, body: body?.length ? new Uint8Array(body) : undefined });
    } catch (e) {
      log.warn("contrib-api relay failed", { contrib: name, error: (e as Error)?.message ?? String(e) });
      return { status: 502, json: { error: "the broker is unreachable" } };
    }
    // Passed through as-is: status, content type and body are the contrib's contract
    // with its own tab, and nothing here interprets them.
    const out = Buffer.from(await res.arrayBuffer());
    const outHeaders: Record<string, string> = {};
    const ct = res.headers.get("content-type");
    if (ct) outHeaders["Content-Type"] = ct;
    ctx.res.writeHead(res.status, outHeaders);
    ctx.res.end(out);
    return undefined;
  };

  const user = relayTo(async () => "user");
  const conversation = relayTo(async (ctx) => {
    const key = deps.conversationKey ? await deps.conversationKey(ctx.params.id) : null;
    return key ? `conversation/${encodeURIComponent(key)}` : null;
  });
  for (const m of METHODS) {
    r.on(m, "/contrib-api/:contrib/*", user);
    r.on(m, "/conversations/:id/contrib-api/:contrib/*", conversation);
  }
}
