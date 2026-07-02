/**
 * Tiny method+path router over node:http — no framework dependency.
 *
 * Routes use `:param` segments. Handlers get parsed params + the parsed JSON
 * body (for non-GET). A handler returns a JsonResult to send JSON, or handles
 * the response itself (e.g. SSE) and returns undefined.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  resolverFromEnv,
  type UserContext,
} from "../auth/identity.js";

/** How the router resolves the caller's identity per request. Async so a resolver
 *  can enrich via a store (identityStore.ts). Defaults to the env-configured
 *  resolver (header by default; alb-oidc when AUTH_MODE=alb-oidc), no store. */
export type ResolveUser = (req: IncomingMessage) => Promise<UserContext> | UserContext;

function defaultResolveUser(): ResolveUser {
  const resolver = resolverFromEnv();
  return (req) => resolver.resolve(req);
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: <T = unknown>() => Promise<T>;
  /** The caller's identity, extracted from the trusted ingress header (or
   *  anonymous when none). Used for conversation ownership / view-filtering. */
  user: UserContext;
}

export type JsonResult = { status?: number; json: unknown };
export type Handler = (ctx: Ctx) => Promise<JsonResult | void> | JsonResult | void;

interface Route {
  method: string;
  segments: string[]; // e.g. ["conversations", ":id", "suspend"]
  handler: Handler;
}

export interface Router {
  on(method: string, path: string, handler: Handler): Router;
  get(path: string, handler: Handler): Router;
  post(path: string, handler: Handler): Router;
  del(path: string, handler: Handler): Router;
  /** Returns true if a route matched + was dispatched. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export function createRouter(resolveUser: ResolveUser = defaultResolveUser()): Router {
  const routes: Route[] = [];

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

  const match = (route: Route, parts: string[]): Record<string, string> | null => {
    if (route.segments.length !== parts.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < parts.length; i++) {
      const seg = route.segments[i];
      if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) return null;
    }
    return params;
  };

  const router: Router = {
    on(method, path, handler) {
      routes.push({
        method: method.toUpperCase(),
        segments: path.split("/").filter(Boolean),
        handler,
      });
      return router;
    },
    get(path, handler) {
      return router.on("GET", path, handler);
    },
    post(path, handler) {
      return router.on("POST", path, handler);
    },
    del(path, handler) {
      return router.on("DELETE", path, handler);
    },

    async handle(req, res) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      for (const route of routes) {
        if (route.method !== (req.method ?? "GET")) continue;
        const params = match(route, parts);
        if (!params) continue;

        let cachedBody: string | undefined;
        const ctx: Ctx = {
          req,
          res,
          params,
          query: url.searchParams,
          user: await resolveUser(req),
          body: async <T,>() => {
            cachedBody ??= await readBody(req);
            return (cachedBody ? JSON.parse(cachedBody) : {}) as T;
          },
        };
        const result = await route.handler(ctx);
        if (result && typeof result === "object" && "json" in result) {
          res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result.json));
        }
        return true;
      }
      return false;
    },
  };
  return router;
}
