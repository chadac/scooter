/**
 * Broker-backed SandboxProvisioner — the agent-host no longer touches the k8s
 * Sandbox/SA/PVC API directly; it calls the BROKER's lifecycle API, which owns all
 * of that (see todo/CONTROL_PLANE_REDESIGN.md). The agent-host's only remaining
 * direct k8s use is pods/exec.
 *
 * Implements the same SandboxProvisioner interface as createK8sProvisioner, so the
 * session manager is unchanged — only the construction in index.ts differs (gated by
 * SANDBOX_VIA_BROKER). Authenticates with the agent-host's own SA token (a CONTROL
 * caller the broker allowlists).
 *
 * The broker keys sandboxes by the SHORT conversation id; a ref's name is `conv-<id>`,
 * so we derive the id from the ref for suspend/resume/destroy. ensure/resume return
 * the pod ref INCLUDING podIP so the exec client + web proxy reach the pod without
 * the agent-host listing pods.
 */

import type { SandboxRef } from "../types.js";
import type { SandboxProvisioner } from "./manager.js";
import type { SandboxResources } from "./resources.js";
import { brokerAuthHeaders } from "./brokerAuth.js";

/** The broker provisioner ALSO exposes the size-spec ops (GET/PUT /sandbox/{conv}/size).
 *  These are distinct from the lifecycle interface: they key by the SHORT conv id the
 *  broker stores sizes under (the same id ensure/resume use), not a SandboxRef. */
export interface BrokerSizeClient {
  /** GET /sandbox/{conv}/size — the stored friendly size spec, or undefined if none. */
  getSize(conv: string): Promise<SandboxResources | undefined>;
  /** PUT /sandbox/{conv}/size — write the size spec (applied on the next restart). */
  setSize(conv: string, resources: SandboxResources): Promise<void>;
}

export type BrokerProvisioner = SandboxProvisioner & BrokerSizeClient;

export interface BrokerProvisionerOptions {
  /** Broker base URL, e.g. http://agent-broker.<ns>.svc.cluster.local:8080. */
  brokerUrl: string;
  /** Injectable fetch (tests inject a fake broker). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface PodRefResponse {
  name: string;
  namespace: string;
  podIP?: string;
  running?: boolean;
}

/** conv-<id> -> <id> (the short id the broker keys on). */
function convId(ref: SandboxRef): string {
  return ref.name.replace(/^conv-/, "");
}

export function createBrokerProvisioner(opts: BrokerProvisionerOptions): BrokerProvisioner {
  const base = opts.brokerUrl.replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;

  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: await brokerAuthHeaders(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return res;
  };

  /** Throw on a non-2xx (surfacing the broker's error), tolerating an OPTIONAL
   *  ignore-status (e.g. 404 on suspend/destroy). Returns the parsed JSON otherwise. */
  const json = async (res: Response, ctx: string, ignore?: number): Promise<unknown> => {
    if (res.status === ignore) return undefined;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`broker ${ctx} failed: ${res.status} ${detail.slice(0, 500)}`);
    }
    return res.json().catch(() => undefined);
  };

  const toRef = (r: PodRefResponse | undefined, fallbackName: string): SandboxRef => ({
    name: r?.name ?? fallbackName,
    namespace: r?.namespace ?? "",
    podIP: r?.podIP,
  });

  return {
    async create(id: string, threadId?: string): Promise<SandboxRef> {
      const res = await call("POST", `/sandbox/${encodeURIComponent(id)}/ensure`, { threadId });
      const r = (await json(res, `ensure ${id}`)) as PodRefResponse | undefined;
      return toRef(r, `conv-${id}`);
    },

    async suspend(ref: SandboxRef): Promise<void> {
      const res = await call("POST", `/sandbox/${encodeURIComponent(convId(ref))}/suspend`);
      await json(res, `suspend ${ref.name}`, 404); // a gone sandbox is already suspended
    },

    async resume(ref: SandboxRef): Promise<SandboxRef> {
      // The broker applies the stored size spec on resume (sizing is broker-owned now).
      const res = await call("POST", `/sandbox/${encodeURIComponent(convId(ref))}/resume`);
      const r = (await json(res, `resume ${ref.name}`)) as PodRefResponse | undefined;
      return toRef(r, ref.name);
    },

    async destroy(ref: SandboxRef): Promise<void> {
      const res = await call("POST", `/sandbox/${encodeURIComponent(convId(ref))}/end`);
      await json(res, `end ${ref.name}`, 404); // already gone == already destroyed
    },

    async reconcile(): Promise<Array<{ ref: SandboxRef; running: boolean }>> {
      const res = await call("GET", `/sandbox`);
      const body = (await json(res, "list sandboxes")) as { sandboxes?: PodRefResponse[] } | undefined;
      return (body?.sandboxes ?? []).map((s) => ({
        ref: { name: s.name, namespace: s.namespace },
        running: s.running ?? false,
      }));
    },

    // --- size spec (GET/PUT /sandbox/{conv}/size) -------------------------------
    // Keyed by the SHORT conv id (the same id ensure/resume use), passed directly by
    // the caller — NOT a SandboxRef. The broker applies a written size on the next
    // sandbox restart (sizing is broker-owned).
    async getSize(conv: string): Promise<SandboxResources | undefined> {
      const res = await call("GET", `/sandbox/${encodeURIComponent(conv)}/size`);
      const body = (await json(res, `get size ${conv}`)) as { size?: SandboxResources | null } | undefined;
      return body?.size ?? undefined;
    },

    async setSize(conv: string, resources: SandboxResources): Promise<void> {
      const res = await call("PUT", `/sandbox/${encodeURIComponent(conv)}/size`, resources);
      await json(res, `set size ${conv}`);
    },
  };
}
