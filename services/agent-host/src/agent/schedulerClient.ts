/**
 * HTTP SchedulerClient — the agent-host's client to the scheduler service's REST
 * API (SCHEDULER_URL). Every call carries the conversation owner as `x-auth-user`
 * so the scheduler attributes/scopes the task to that user (the agent can only
 * manage its own owner's tasks). Optional relay key as Bearer.
 */

import type { SchedulerClient, ScheduledTask, TaskRun } from "./schedulerTools.js";

export interface HttpSchedulerClientDeps {
  baseUrl: string;
  relayKey?: string;
  fetchImpl?: typeof fetch;
}

export function createHttpSchedulerClient(deps: HttpSchedulerClientDeps): SchedulerClient {
  const doFetch = deps.fetchImpl ?? fetch;
  const base = deps.baseUrl.replace(/\/$/, "");

  const headers = (owner: string): Record<string, string> => {
    const h: Record<string, string> = { "content-type": "application/json", "x-auth-user": owner };
    if (deps.relayKey) h.authorization = `Bearer ${deps.relayKey}`;
    return h;
  };

  const req = async (owner: string, method: string, path: string, body?: unknown): Promise<Response> =>
    doFetch(`${base}${path}`, { method, headers: headers(owner), body: body === undefined ? undefined : JSON.stringify(body) });

  return {
    async create(owner, body) {
      const r = await req(owner, "POST", "/tasks", body);
      if (!r.ok) throw new Error(`scheduler create ${r.status}: ${await r.text().catch(() => "")}`);
      return (await r.json()) as ScheduledTask;
    },
    async list(owner) {
      const r = await req(owner, "GET", "/tasks");
      if (!r.ok) throw new Error(`scheduler list ${r.status}`);
      return (await r.json()) as ScheduledTask[];
    },
    async get(owner, id) {
      const r = await req(owner, "GET", `/tasks/${encodeURIComponent(id)}`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`scheduler get ${r.status}`);
      return (await r.json()) as ScheduledTask;
    },
    async patch(owner, id, patch) {
      const r = await req(owner, "PATCH", `/tasks/${encodeURIComponent(id)}`, patch);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`scheduler patch ${r.status}: ${await r.text().catch(() => "")}`);
      return (await r.json()) as ScheduledTask;
    },
    async del(owner, id) {
      const r = await req(owner, "DELETE", `/tasks/${encodeURIComponent(id)}`);
      if (r.status === 404) return false;
      if (!r.ok) throw new Error(`scheduler delete ${r.status}`);
      return true;
    },
    async runs(owner, id) {
      const r = await req(owner, "GET", `/tasks/${encodeURIComponent(id)}/runs`);
      if (!r.ok) throw new Error(`scheduler runs ${r.status}`);
      return (await r.json()) as TaskRun[];
    },
  };
}
