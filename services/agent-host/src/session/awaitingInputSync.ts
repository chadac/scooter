/**
 * Keeps the sidebar's "!" in step with the event log: on while any interrupt is unsettled,
 * since the latest one was raised. Every change re-derives it from the log, so answering
 * one of two cards keeps it on, and a write that failed is put right by a later retry.
 */

import type { AguiEvent } from "../bridge.js";
import { formatError, logger } from "../log.js";
import type { SessionId } from "../types.js";
import type { AwaitingInputStore } from "./awaitingInputStore.js";

const log = logger("awaitingInput");

/** When the current wait began: the latest unsettled raise's time, or null if none. */
export function awaitingSince(events: AguiEvent[], now: number): number | null {
  const open = new Map<string, number>();
  for (const e of events) {
    if (e.type === "PERMISSION_RESOLVED") open.delete(e.toolCallId);
    else if (e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt") {
      for (const i of e.outcome.interrupts) open.set(i.id, typeof e.ts === "number" ? e.ts : now);
    }
  }
  return open.size === 0 ? null : Math.max(...open.values());
}

/** Whether an appended event can change the "!". */
export function changesAwaiting(event: AguiEvent): boolean {
  return event.type === "PERMISSION_RESOLVED" || (event.type === "RUN_FINISHED" && event.outcome?.type === "interrupt");
}

export interface AwaitingInputSyncDeps {
  store: Pick<AwaitingInputStore, "set">;
  /** The conversation's whole log; throws when it cannot be read. */
  readEvents(id: SessionId): Promise<AguiEvent[]>;
  /** Waits before each retry of a failed sync; the last failure gives up. */
  retryDelaysMs?: number[];
  schedule?(fn: () => void, ms: number): void;
  now?(): number;
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000];

function defaultSchedule(fn: () => void, ms: number): void {
  setTimeout(fn, ms).unref?.();
}

/** Returns sync(id): derive the conversation's "!" from its log and write it, retrying on failure. */
export function createAwaitingInputSync(deps: AwaitingInputSyncDeps): (id: SessionId) => Promise<void> {
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const schedule = deps.schedule ?? defaultSchedule;
  const now = deps.now ?? Date.now;
  // In-flight syncs; `again` reruns one after a mid-sync change.
  const inFlight = new Map<SessionId, { again: boolean }>();
  const failures = new Map<SessionId, number>();
  const retryPending = new Set<SessionId>();

  const writeOnce = async (id: SessionId): Promise<void> => {
    let events: AguiEvent[];
    try {
      events = await deps.readEvents(id);
    } catch (e) {
      log.warn("awaiting-input sync could not read the log", { conversation_id: id, error: formatError(e) });
      throw e;
    }
    await deps.store.set(id, awaitingSince(events, now()));
  };

  const sync = async (id: SessionId): Promise<void> => {
    const running = inFlight.get(id);
    if (running) {
      running.again = true;
      return;
    }
    const me = { again: false };
    inFlight.set(id, me);
    let ok = false;
    try {
      do {
        me.again = false;
        await writeOnce(id);
      } while (me.again);
      ok = true;
    } catch {
      // Both failure paths have logged; the retry below handles it.
    } finally {
      inFlight.delete(id);
    }
    if (ok) {
      failures.delete(id);
      return;
    }
    const failed = failures.get(id) ?? 0;
    if (failed >= delays.length) {
      failures.delete(id);
      log.error("awaiting-input sync gave up; the sidebar may be wrong until the next question", {
        conversation_id: id,
        attempts: failed + 1,
      });
      return;
    }
    failures.set(id, failed + 1);
    if (retryPending.has(id)) return;
    retryPending.add(id);
    schedule(() => {
      retryPending.delete(id);
      void sync(id);
    }, delays[failed]);
  };
  return sync;
}
