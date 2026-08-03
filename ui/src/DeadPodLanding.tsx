/**
 * A generic landing screen shown in the conversation area when the current
 * conversation's pod is DOWN (suspended by the idle sweep, or ended). Instead of the
 * thread rendering into a dead pod — which surfaced as "upstream failed" / silent
 * breakage — the user gets a clear Start button that resumes the conversation and
 * polls it back to running. Mirrors the web-service loading page (PR #204), one level
 * up: the whole conversation, not one service.
 *
 * Reuses useSandboxStatus (SandboxPanel) for the live status + the resume action, so
 * there's ONE source of truth for pod state.
 */

import type { SandboxState } from "./SandboxPanel.js";

export interface DeadPodLandingProps {
  state: SandboxState;
  /** Resume + poll to running (useSandboxStatus.startSandbox). */
  onStart: () => void;
}

/** Should the landing REPLACE the thread? Only when the pod is genuinely down and a
 *  Start would help: suspended (idle-dropped, resumable) or ended. NOT for
 *  running/starting (thread/loading is fine) or unknown (still checking — don't flash
 *  a scary screen on a transient). */
export function shouldShowDeadPodLanding(state: SandboxState): boolean {
  return state === "suspended" || state === "ended";
}

export function DeadPodLanding({ state, onStart }: DeadPodLandingProps) {
  const ended = state === "ended";
  return (
    <div
      data-testid="dead-pod-landing"
      data-state={state}
      className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center"
    >
      <div className="text-4xl" aria-hidden>
        😴
      </div>
      <h2 className="text-lg font-medium">
        {ended ? "This conversation was ended" : "This conversation is asleep"}
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        {ended
          ? "Its sandbox was shut down. Start it to bring the environment back and continue where you left off."
          : "Its sandbox was suspended after being idle (your files and history are kept). Start it to resume."}
      </p>
      <button
        data-testid="dead-pod-start"
        onClick={onStart}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Start conversation
      </button>
    </div>
  );
}

/** The "coming back up" state — shown while a resume is in flight (state
 *  "starting"), so the Start click gives immediate feedback instead of a frozen
 *  screen while the pod is ContainerCreating. */
export function StartingPodLanding() {
  return (
    <div
      data-testid="starting-pod-landing"
      className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center"
    >
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" aria-hidden />
      <h2 className="text-lg font-medium">Starting the conversation…</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Bringing the sandbox back up — this takes a few seconds.
      </p>
    </div>
  );
}
