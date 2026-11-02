/**
 * Visibility across agent-host replicas. A visibility change lands on one replica, and the
 * broker reads GET /conversations/{id} from whichever replica answers, to decide whether a
 * conversation may use its owner's credentials (SSH key, forge tokens). A replica that
 * loaded the conversation earlier must still report the stored visibility.
 */

import type { APIRequestContext } from "@playwright/test";

import { test, expect, seedConversation } from "./fixtures.js";
import { fastOnly } from "./target.js";

const REPLICA = `http://127.0.0.1:${process.env.E2E_AGENT_HOST_REPLICA_PORT ?? "8078"}`;
const OWNER = { "x-auth-user": "alice" };
const baseOf = (baseURL?: string) => (baseURL ?? "http://localhost:5173").replace(/\/$/, "");

async function replicaVisibility(request: APIRequestContext, id: string): Promise<string> {
  const r = await request.get(`${REPLICA}/conversations/${id}`, { headers: OWNER });
  expect(r.ok(), `replica GET /conversations/${id}: ${r.status()}`).toBeTruthy();
  return ((await r.json()) as { visibility: string }).visibility;
}

async function setVisibility(request: APIRequestContext, base: string, id: string, body: object): Promise<void> {
  const r = await request.patch(`${base}/conversations/${id}/visibility`, { data: body, headers: OWNER });
  expect(r.ok(), `PATCH visibility: ${r.status()} ${await r.text()}`).toBeTruthy();
}

fastOnly("needs a second agent-host replica the router does not route to")(
  "visibility across agent-host replicas",
  () => {
    test("a replica that loaded a shared conversation reports it private once made private", async ({
      request,
      baseURL,
    }) => {
      const id = await seedConversation(request, baseOf(baseURL), "alice", "made private on another replica");
      expect(await replicaVisibility(request, id)).toBe("shared");

      await setVisibility(request, baseOf(baseURL), id, { visibility: "private" });

      expect(await replicaVisibility(request, id)).toBe("private");
    });

    test("a replica that loaded a private conversation reports it shared once made shared", async ({
      request,
      baseURL,
    }) => {
      const id = await seedConversation(request, baseOf(baseURL), "alice", "made shared on another replica");
      await setVisibility(request, baseOf(baseURL), id, { visibility: "private" });
      expect(await replicaVisibility(request, id)).toBe("private");

      await setVisibility(request, baseOf(baseURL), id, { visibility: "shared", confirm: true });

      expect(await replicaVisibility(request, id)).toBe("shared");
    });
  },
);
