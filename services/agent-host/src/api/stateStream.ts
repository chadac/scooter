// The contrib publish route; topics reach tabs on events.integrity.

import type { IncomingMessage } from "node:http";

import type { Router } from "../http/router.js";
import type { StateHub } from "../session/stateHub.js";

// Manifest-style names only, so a topic cannot smuggle a separator.
const CONTRIB_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Bigger values belong behind the contrib's own GET route.
const MAX_CONTRIB_DATA_BYTES = 64 * 1024;

export interface StateStreamDeps {
  hub: StateHub;
  /** Conversation id or sandbox key to conversation id, hydrating if absent. */
  resolve(id: string): Promise<string | null>;
  fromService(req: IncomingMessage): Promise<boolean>;
}

export function mountStateStream(r: Router, deps: StateStreamDeps): void {
  // Body `{data?}`: data is pushed as-is, absent means subscribers refetch.
  r.post("/conversations/:id/state/contrib/:contrib", async (ctx) => {
    if (!(await deps.fromService(ctx.req))) {
      return { status: 403, json: { error: "only a platform service may call this" } };
    }
    const contrib = ctx.params.contrib;
    if (!CONTRIB_NAME.test(contrib)) return { status: 400, json: { error: "invalid contrib name" } };
    const body = await ctx.body<{ data?: unknown } | null>().catch(() => null);
    const data = body && typeof body === "object" ? body.data : undefined;
    if (data !== undefined && JSON.stringify(data).length > MAX_CONTRIB_DATA_BYTES) {
      return { status: 413, json: { error: "data too large; publish without data and let the UI refetch" } };
    }
    const id = await deps.resolve(ctx.params.id);
    if (!id) return { status: 404, json: { error: "unknown conversation" } };
    // useContribTopic reads the same name.
    deps.hub.publish(id, `contrib:${contrib}`, data);
    return { status: 202, json: { ok: true } };
  });
}
