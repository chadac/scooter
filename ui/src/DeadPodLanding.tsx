/**
 * The "coming back up" screen shown in the conversation area WHILE an explicit
 * Sandbox-tab Start is in flight (state "starting"), so the click gives immediate
 * feedback instead of a frozen screen while the pod is ContainerCreating.
 *
 * NOTE: an asleep (suspended/ended) conversation no longer gets a full-screen
 * takeover. The thread + its history render straight off the persisted integrity
 * stream (no live pod needed), and sending a message resumes the pod automatically
 * (promptByThread revives before it runs). So the old DeadPodLanding takeover was
 * removed; only this brief starting spinner remains, for the explicit-Start case.
 */

/** Shown while a resume kicked off from the Sandbox tab is in flight (state
 *  "starting"), so the Start click gives immediate feedback. */
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
