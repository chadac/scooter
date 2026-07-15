/**
 * Tier 1 contract — the broker-backed SandboxProvisioner. Asserts each method hits
 * the right broker endpoint/verb/body and maps the response ref (incl. podIP), and
 * that suspend/destroy tolerate a 404 (a gone sandbox is already suspended/destroyed).
 * A fake fetch stands in for the broker.
 */

import { describe, it, expect, vi } from "vitest";

import { createBrokerProvisioner } from "../../src/session/brokerProvisioner.js";

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

/** A fake fetch that records calls and returns a scripted response per path suffix. */
function fakeBroker(script: (path: string) => { status: number; json?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const path = u.replace("http://broker", "");
    const { status, json } = script(path);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => (json ? JSON.stringify(json) : ""),
    } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const prov = (fetchImpl: typeof fetch) =>
  createBrokerProvisioner({ brokerUrl: "http://broker", fetchImpl });

describe("brokerProvisioner", () => {
  it("create() POSTs ensure with threadId and maps {name,namespace,podIP}", async () => {
    const { calls, fetchImpl } = fakeBroker(() => ({
      status: 200,
      json: { name: "conv-c1", namespace: "ns", podIP: "10.0.0.5", running: true },
    }));
    const ref = await prov(fetchImpl).create("c1", "thread-1");
    expect(calls[0]).toMatchObject({ url: "http://broker/sandbox/c1/ensure", method: "POST", body: { threadId: "thread-1" } });
    expect(ref).toEqual({ name: "conv-c1", namespace: "ns", podIP: "10.0.0.5" });
  });

  it("suspend() POSTs suspend (deriving the id from the ref name)", async () => {
    const { calls, fetchImpl } = fakeBroker(() => ({ status: 200, json: { suspended: true } }));
    await prov(fetchImpl).suspend({ name: "conv-c1", namespace: "ns" });
    expect(calls[0]).toMatchObject({ url: "http://broker/sandbox/c1/suspend", method: "POST" });
  });

  it("suspend() tolerates a 404 (already gone == already suspended)", async () => {
    const { fetchImpl } = fakeBroker(() => ({ status: 404 }));
    await expect(prov(fetchImpl).suspend({ name: "conv-gone", namespace: "ns" })).resolves.toBeUndefined();
  });

  it("resume() POSTs resume and returns the ref with the new podIP", async () => {
    const { calls, fetchImpl } = fakeBroker(() => ({ status: 200, json: { name: "conv-c1", namespace: "ns", podIP: "10.0.0.9" } }));
    const ref = await prov(fetchImpl).resume({ name: "conv-c1", namespace: "ns" });
    expect(calls[0]).toMatchObject({ url: "http://broker/sandbox/c1/resume", method: "POST" });
    expect(ref.podIP).toBe("10.0.0.9");
  });

  it("destroy() POSTs end and tolerates 404", async () => {
    const { calls, fetchImpl } = fakeBroker(() => ({ status: 404 }));
    await expect(prov(fetchImpl).destroy({ name: "conv-c1", namespace: "ns" })).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ url: "http://broker/sandbox/c1/end", method: "POST" });
  });

  it("reconcile() GETs /sandbox and maps the list", async () => {
    const { fetchImpl } = fakeBroker(() => ({
      status: 200,
      json: { sandboxes: [{ name: "conv-a", namespace: "ns", running: true }, { name: "conv-b", namespace: "ns", running: false }] },
    }));
    const out = await prov(fetchImpl).reconcile!();
    expect(out).toEqual([
      { ref: { name: "conv-a", namespace: "ns" }, running: true },
      { ref: { name: "conv-b", namespace: "ns" }, running: false },
    ]);
  });

  it("surfaces a non-2xx (that isn't the tolerated status) as an error", async () => {
    const { fetchImpl } = fakeBroker(() => ({ status: 500, json: { detail: "boom" } }));
    await expect(prov(fetchImpl).create("c1")).rejects.toThrow(/ensure c1 failed: 500/);
  });
});
