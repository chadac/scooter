/**
 * OwnershipGuard — the multi-replica FENCING layer. Before this pod appends to a
 * conversation's durable log, it checks that IT is still the owner (status.hostPod on
 * the Conversation CR) at the generation it was assigned under. A pod that was
 * REASSIGNED away (the controller bumped hostPod + generation) must stop writing so it
 * can't corrupt the log the new owner now drives.
 *
 * This is a belt-and-suspenders 3rd layer: the controller (one hostPod at a time) + the
 * #248 drain (old owner quiesces on shutdown) + the router (forwards only to hostPod)
 * already prevent double-writes in normal operation. Fencing catches the edge case of a
 * briefly-partitioned old owner.
 *
 * CRUCIAL: canWrite() is SYNCHRONOUS and does NO k8s I/O — it reads a CACHED view kept
 * fresh by a watch (see k8sOwnershipGuard). appendEvent fires once per streamed token, so
 * a per-append k8s call would wreck latency.
 */

import type { SessionId } from "../types.js";

export interface OwnershipGuard {
  /** May THIS pod append to `id`'s log right now? True unless the cache says another
   *  pod owns it (or this pod's assignment generation is stale). Fail-OPEN on unknown
   *  (not yet in cache) so a brand-new conversation isn't blocked before its CR exists. */
  canWrite(id: SessionId): boolean;
  /** The generation of the CACHED assignment for `id` (undefined when unobserved).
   *  Lets a caller holding out-of-band knowledge (the controller's revive push carries
   *  the generation it JUST wrote) tell a stale CACHE from a stale PUSH. Optional: the
   *  allow-all guard has no cache. */
  observedGeneration?(id: SessionId): number | undefined;
  /** Adopt an assignment announced out-of-band: the controller POSTs /internal/revive
   *  immediately after writing hostPod=<this pod> at `generation`, and that push
   *  routinely arrives BEFORE the watch event for the same write. Recording it here
   *  keeps canWrite() truthful during the lag (the watch then confirms — or, if the
   *  CR moved on again, corrects — the entry). Optional: only the tracked guard can. */
  adoptAssignment?(id: SessionId, generation: number): void;
}

/** A guard that always allows — the single-replica / fencing-disabled default (a no-op,
 *  so append behaves exactly as today). */
export const allowAllGuard: OwnershipGuard = { canWrite: () => true };

/** One conversation's assignment as observed from its Conversation CR. */
export interface Assignment {
  hostPod: string;
  generation: number;
}

/**
 * The pure decision core, testable without k8s. Holds a cache of conversationId ->
 * Assignment (updated by the watch loop) and the pod's OWN identity + the generation it
 * believes it was assigned under.
 */
export class OwnershipTracker implements OwnershipGuard {
  /** conversationId -> the CR's current {hostPod, generation}. */
  private readonly assignments = new Map<string, Assignment>();
  /** conversationId -> the generation THIS pod started hosting under (its claim epoch). */
  private readonly claimedGen = new Map<string, number>();

  /** Fired when the watch shows this pod GAINING a conversation it did not hold —
   *  a reassignment landing here, or the boot list revealing prior assignments.
   *  THE settlement hook for stranded runs: every earlier hook (the revive push,
   *  ensureReadable, hydrateByThread) had a path around it — the push can be lost
   *  with the dying pod, and the hydrate cascade means adoption often finds the
   *  entry already present and returns early. The ownership watch is the one
   *  signal that ALWAYS fires on a reassignment, because it is the same event
   *  stream the write fence itself trusts. Not fired on same-owner echoes. */
  onGained?: (id: string, generation: number) => void;

  constructor(private readonly selfPod: string) {}

  /** Called by the watch when a Conversation CR changes. */
  observe(id: string, a: Assignment | null): void {
    if (a === null) {
      this.assignments.delete(id);
      this.claimedGen.delete(id);
      return;
    }
    const prev = this.assignments.get(id);
    this.assignments.set(id, a);
    // The FIRST time we see ourselves as the host, record the generation as our claim.
    // A later generation bump AWAY from us (or to us again) is handled by canWrite.
    if (a.hostPod === this.selfPod && !this.claimedGen.has(id)) {
      this.claimedGen.set(id, a.generation);
    }
    // GAIN = we are the host now and were not before (no prior view, or another pod).
    if (a.hostPod === this.selfPod && prev?.hostPod !== this.selfPod) {
      this.onGained?.(id, a.generation);
    }
  }

  observedGeneration(id: SessionId): number | undefined {
    return this.assignments.get(id as string)?.generation;
  }

  adoptAssignment(id: SessionId, generation: number): void {
    // The caller (reviveFromMirror) has verified this push is NEWER than the cached
    // view; record this pod as owner at that generation. If the CR has since moved on
    // yet again, the watch delivers the newer assignment and overwrites this entry.
    this.observe(id as string, { hostPod: this.selfPod, generation });
  }

  canWrite(id: SessionId): boolean {
    const a = this.assignments.get(id as string);
    // Unknown (no CR yet / not observed): fail-OPEN — a new conversation must be able to
    // write before its CR is created + assigned. The controller assigns shortly; a
    // subsequent reassignment away would then flip this false.
    if (a === undefined) return true;
    // Owned by ANOTHER pod now -> we must not write.
    if (a.hostPod !== this.selfPod) return false;
    // Owned by us, but at a generation NEWER than the one we claimed under -> we were
    // reassigned away and back (or the CR advanced past our claim); the current owner is
    // us at `a.generation`, so re-record and allow. (Same-gen = normal, allow.)
    const claimed = this.claimedGen.get(id);
    if (claimed === undefined || a.generation > claimed) {
      this.claimedGen.set(id, a.generation);
    }
    return true;
  }
}
