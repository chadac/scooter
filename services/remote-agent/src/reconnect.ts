/**
 * Reconnect backoff for the container's cloud connection.
 *
 * Extracted from remoteAgentClient so it can be tested without a socket. The shipped loop was
 * `setTimeout(connect, 3000)` — fixed interval, no jitter, forever.
 *
 * Why that matters here specifically: the container runs on the USER'S machine with
 * `--restart always` and reconnects to a SINGLE-REPLICA controller (§L decision 3). After a routine
 * rollout every container in the fleet reconnects on the same tick and keeps retrying in lockstep,
 * so the controller comes back up into a synchronised herd. Exponential backoff disperses the load;
 * jitter is what actually breaks the lockstep (backoff alone keeps everyone aligned, just at wider
 * intervals).
 *
 * The cap matters in the other direction: an uncapped doubling would leave a user's agent offline
 * long after the cloud returned. Recovery should stay prompt even after a long outage.
 */

/** First retry — fast, so a rollout does not feel like an outage. */
export const RECONNECT_BASE_MS = 1_000;
/** Ceiling — long enough to stop hammering, short enough to recover promptly. */
export const RECONNECT_CAP_MS = 30_000;

/**
 * Delay before reconnect attempt `attempt` (1-based). Full-jitter exponential backoff: the delay is
 * a random point in [half, full] of the capped exponential window, which disperses a herd while
 * keeping every retry bounded and non-zero.
 *
 * `rand` is injectable so the tests can pin the jitter instead of asserting on randomness.
 */
export function nextReconnectDelay(attempt: number, rand: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  // Cap the EXPONENT before the multiply so a large attempt count cannot overflow to Infinity.
  const exponent = Math.min(n - 1, 32);
  // ONE cap, applied to the window before jitter. Capping again on the return would be redundant
  // (and hid a mutant: removing either clamp left behaviour unchanged, so neither was provably
  // tested). Jitter is half-to-full of the window, so the result is always in (0, CAP].
  const window = Math.min(RECONNECT_BASE_MS * 2 ** exponent, RECONNECT_CAP_MS);
  const jittered = window * (0.5 + 0.5 * Math.min(Math.max(rand(), 0), 1));
  return Math.max(1, Math.round(jittered));
}

// --- Close-code interpretation (why did the cloud hang up?) ---------------------------------
//
// The controller closes with an APPLICATION code + reason for conditions the container should
// react to differently than "the network blipped". Ignoring the code was a live failure mode:
// a container whose join token was rejected logged a generic `disconnected (code 1005)` and
// retried on the fast schedule forever — the machine looked "totally fine" while it was
// permanently unauthenticated, and nothing on either end said so.

/** The controller REJECTED this connection's credentials (bad/expired/mismatched token). */
export const CLOSE_AUTH_REJECTED = 4001;
/** Another container for the same owner connected; this one was superseded (last-writer-wins). */
export const CLOSE_SUPERSEDED = 4002;

/** Retry cadence for a REJECTED authentication. Slow on purpose: an auth failure does not fix
 *  itself by retrying — a human has to fetch a fresh command — but a slow retry still recovers
 *  unattended once the server side is fixed (a re-registered device, a restored controller). */
export const AUTH_RETRY_MS = 5 * 60_000;
/** Retry cadence after being superseded: slow enough that two containers for one owner do not
 *  ping-pong each other every second, fast enough to take over when the other one stops. */
export const SUPERSEDED_RETRY_MS = 60_000;

export interface CloseDisposition {
  /** What the container should tell its human — specific, actionable, or null for the generic
   *  "disconnected (code N)" line. */
  message: string | null;
  delayMs: number;
}

/** Decide the log line + retry delay for a server close. Pure, so the policy is testable. */
export function closeDisposition(
  code: number,
  reason: string,
  attempt: number,
  rand: () => number = Math.random,
): CloseDisposition {
  if (code === CLOSE_AUTH_REJECTED) {
    return {
      message:
        `AUTHENTICATION FAILED: ${reason || "the server rejected this container's credentials"}. ` +
        `Retrying every ${AUTH_RETRY_MS / 60000} min, but this will not fix itself — ` +
        `get a fresh docker command from the Settings page.`,
      delayMs: AUTH_RETRY_MS,
    };
  }
  if (code === CLOSE_SUPERSEDED) {
    return {
      message:
        `superseded: ${reason || "another container connected for this account"} — ` +
        `this one is standing by (stop one of them to avoid confusion).`,
      delayMs: SUPERSEDED_RETRY_MS,
    };
  }
  return { message: null, delayMs: nextReconnectDelay(attempt, rand) };
}
