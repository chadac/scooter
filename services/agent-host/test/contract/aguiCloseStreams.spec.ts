/** close() ends router-held SSE streams cleanly, so nginx sees no upstream reset. */

import { describe, it, expect } from "vitest";
import { request } from "node:http";

import { createAguiServer } from "../../src/agui/server.js";
import { createRouter } from "../../src/http/router.js";

/** Open `path` and resolve once its headers arrive, with a promise for how the body ends. */
function openStream(port: number, path: string): Promise<{ ended: Promise<"end" | "aborted"> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path }, (res) => {
      res.resume();
      const ended = new Promise<"end" | "aborted">((done) => {
        res.on("end", () => done("end"));
        res.on("aborted", () => done("aborted"));
        res.on("error", () => done("aborted"));
      });
      resolve({ ended });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("AguiServer.close", () => {
  it("ends a router-held SSE stream cleanly instead of waiting on it", async () => {
    const server = createAguiServer();
    const router = createRouter();
    router.get("/conversations/:id/events.integrity", async (ctx) => {
      ctx.res.writeHead(200, { "Content-Type": "text/event-stream" });
      ctx.res.write(": open\n\n");
    });
    server.use(router);
    await server.listen(0);

    const { ended } = await openStream(server.port()!, "/conversations/c1/events.integrity");
    const closed = server.close().then(() => "closed" as const);
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2_000));

    expect(await Promise.race([closed, timeout])).toBe("closed");
    expect(await ended).toBe("end");
  });
});
