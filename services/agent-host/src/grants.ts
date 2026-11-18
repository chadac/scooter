/**
 * Standing grants: the relay between the Approvals tab and each contrib's
 * `scooter_broker_lib.grants` routes. The platform learns how to reach a contrib's
 * grants, never what they mean; titles, scopes and verbs arrive rendered.
 */

import { approverForBroker, type ApproverIdentity } from "./bridge.js";
import type { ApprovalContrib } from "./api/management.js";

/** One verb a grant offers; `allowed` is whether this viewer may use it. */
export interface GrantVerb {
  verb: string;
  label: string;
  presets_minutes: number[];
  allowed?: boolean;
}

/** A grant as its contrib renders it, tagged with the contrib. snake_case: the broker's wire shape. */
export interface Grant {
  contrib: string;
  id: string;
  title: string;
  scope: string[];
  status: "active" | "expired" | "revoked";
  granted_by: string;
  granted_at: number;
  expires_at: number | null;
  verbs: GrantVerb[];
  parent_id?: string | null;
  ended_at?: number | null;
  ended_by?: string | null;
}

export interface GrantsRelayDeps {
  contribs: Record<string, ApprovalContrib>;
  brokerAuth: () => Promise<{ url: string; headers: Record<string, string> } | null>;
  /** Tell the agent its access changed. */
  notify: (sessionId: string, message: string) => void;
  warn: (msg: string, fields: Record<string, unknown>) => void;
  fetch?: typeof fetch;
}

export interface GrantsRelay {
  /** Every contrib's grants under these conversation keys; a failing contrib is skipped. */
  list(keys: string[], approver: ApproverIdentity): Promise<Grant[]>;
  /** Run a verb as `approver`; the broker's status and body pass through. */
  act(
    sessionId: string,
    keys: string[],
    contrib: string,
    grantId: string,
    verb: string,
    approver: ApproverIdentity,
    minutes?: number,
  ): Promise<{ status: number; json: unknown }>;
  /** End every grant a deleted conversation held; best effort. */
  revokeConversation(keys: string[]): Promise<void>;
}

export function createGrantsRelay(deps: GrantsRelayDeps): GrantsRelay {
  const doFetch = deps.fetch ?? fetch;
  const withGrants = () =>
    Object.entries(deps.contribs).flatMap(([name, c]) =>
      c.grantsPrefix ? [[name, c.grantsPrefix.replace(/\/$/, "")] as const] : [],
    );

  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const auth = await deps.brokerAuth();
    if (!auth) return null;
    return doFetch(`${auth.url}${path}`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  };

  const asBroker = (approver: ApproverIdentity) => {
    const { assertion: _, ...who } = approver;
    return { approver: who, headers: approverForBroker(approver).headers };
  };

  return {
    async list(keys, approver) {
      const { approver: who, headers } = asBroker(approver);
      const lists = await Promise.all(
        withGrants().map(async ([contrib, prefix]) => {
          try {
            const res = await post(`${prefix}/list`, { approver: who, conversation_ids: keys }, headers);
            if (!res) return [];
            if (!res.ok) {
              deps.warn("grants list returned a non-2xx", { contrib, status: res.status });
              return [];
            }
            const body = (await res.json()) as { grants?: Omit<Grant, "contrib">[] };
            return (body.grants ?? []).map((g) => ({ ...g, contrib }));
          } catch (err) {
            deps.warn("grants list failed", { contrib, error: String(err) });
            return [];
          }
        }),
      );
      return lists.flat();
    },

    async act(sessionId, keys, contrib, grantId, verb, approver, minutes) {
      const prefix = deps.contribs[contrib]?.grantsPrefix?.replace(/\/$/, "");
      if (!prefix) return { status: 404, json: { error: `no grants for contrib '${contrib}'` } };
      const { approver: who, headers } = asBroker(approver);
      const res = await post(
        `${prefix}/${encodeURIComponent(grantId)}/${encodeURIComponent(verb)}`,
        { approver: who, conversation_ids: keys, ...(minutes !== undefined ? { minutes } : {}) },
        headers,
      );
      if (!res) return { status: 503, json: { error: "no broker configured" } };
      const json = (await res.json().catch(() => ({}))) as { agent_message?: unknown; detail?: unknown };
      if (!res.ok) {
        const errs = (json.detail as { errors?: unknown } | undefined)?.errors;
        return { status: res.status, json: { error: Array.isArray(errs) ? errs.join("\n") : `broker answered ${res.status}` } };
      }
      if (typeof json.agent_message === "string" && json.agent_message.trim()) {
        deps.notify(sessionId, json.agent_message);
      }
      return { status: 200, json };
    },

    async revokeConversation(keys) {
      await Promise.all(
        withGrants().flatMap(([contrib, prefix]) =>
          keys.map(async (key) => {
            try {
              const res = await post(`${prefix}/revoke-conversation`, { conversation_id: key });
              if (res && !res.ok) deps.warn("revoking a deleted conversation's grants failed", { contrib, status: res.status });
            } catch (err) {
              deps.warn("revoking a deleted conversation's grants failed", { contrib, error: String(err) });
            }
          }),
        ),
      );
    },
  };
}
