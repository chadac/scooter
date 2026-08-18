/**
 * Tier 1 contract — the /agui RESUME branch must never leave a silent, open SSE.
 *
 * The reported bug (docs/scooter-bug-resume-hangs-when-run-not-live.md): a user
 * answers a pending approval via `POST /agui { resume:[…] }`, but the paused run
 * isn't live in memory (rollout / idle-suspend). `onResume` no-ops (no bridge or
 * the interrupt isn't registered), the resume branch has already sent the SSE 200
 * header, and it returns leaving the stream OPEN with ZERO frames — the request
 * hangs until a proxy 502s it and the approval can never complete.
 *
 * The fix makes `onResume` report an outcome and the resume branch:
 *   - keep the stream open ONLY when the resume was answered (a real run resumes
 *     and streams its continued events), and
 *   - emit a RUN_ERROR frame + close when it could NOT be answered (unanswerable /
 *     expired), so the UI renders a failure instead of hanging, and
 *   - close with RUN_ERROR if the branch produces NO frame within a guard window
 *     (defensive: any other silent-hang cause).
 */

import { describe, it, expect } from "vitest";

import { createAguiServer } from "../../src/agui/server.js";

/** POST a resume to /agui and collect the raw SSE body until the socket closes
 *  (or a deadline). Returns the accumulated text so tests can assert on frames.
 *  A HANG (stream never closes) is the bug — surfaced here as a deadline timeout
 *  with no terminal frame. */
async function postResume(
  onResume: (
    sessionId: string,
    entry: { interruptId: string; status: "resolved" | "cancelled"; payload?: unknown },
  ) => Promise<{ ok: boolean; reason?: string }>,
  opts: { deadlineMs?: number } = {},
): Promise<{ body: string; closed: boolean }> {
  const server = createAguiServer();
  server.onResume(onResume);
  await server.listen(0);
  const deadline = opts.deadlineMs ?? 4000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deadline);
  let body = "";
  let closed = false;
  try {
    const res = await fetch(`http://127.0.0.1:${server.port()}/agui`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "t1",
        resume: [{ interruptId: "req-1", status: "resolved", payload: { optionId: "approve" } }],
      }),
      signal: ctrl.signal,
    });
    // Drain the stream; it should CLOSE on its own once the branch ends the response.
    body = await res.text();
    closed = true;
  } catch {
    // AbortError => the stream never closed within the deadline (the hang).
    closed = false;
  } finally {
    clearTimeout(timer);
    await server.close();
  }
  return { body, closed };
}

describe("/agui resume — never a silent open stream", () => {
  it("emits RUN_ERROR and CLOSES when the resume can't be answered (dormant run)", async () => {
    // onResume reports it couldn't answer (bridge-less / interrupt gone even after revive).
    const { body, closed } = await postResume(async () => ({ ok: false, reason: "interrupt not found" }));
    expect(closed, "the resume stream must close, not hang").toBe(true);
    expect(body).toContain("RUN_ERROR");
  });

  it("does NOT force-close a resume that WAS answered (a real run streams its events)", async () => {
    // ok:true => keep the stream open for the resumed run's continued events. With the
    // guard at its 60s default and a 1.5s deadline, the stream stays open and silent —
    // assert we did NOT write a spurious RUN_ERROR (the branch must not error a
    // legitimately-answered resume just because this fake emits no events).
    const { body } = await postResume(async () => ({ ok: true }), { deadlineMs: 1500 });
    expect(body).not.toContain("RUN_ERROR");
  });

  it("guard closes an answered-but-frame-less resume with RUN_ERROR (defensive)", async () => {
    // Belt-and-suspenders: answered (ok:true), but the run streams NOTHING. With a tiny
    // guard window the branch must close the stream with a RUN_ERROR rather than hang.
    const prev = process.env.SCOOTER_RESUME_GUARD_MS;
    process.env.SCOOTER_RESUME_GUARD_MS = "300";
    try {
      const { body, closed } = await postResume(async () => ({ ok: true }), { deadlineMs: 4000 });
      expect(closed, "the guard must close the stream").toBe(true);
      expect(body).toContain("RUN_ERROR");
    } finally {
      if (prev === undefined) delete process.env.SCOOTER_RESUME_GUARD_MS;
      else process.env.SCOOTER_RESUME_GUARD_MS = prev;
    }
  });
});
