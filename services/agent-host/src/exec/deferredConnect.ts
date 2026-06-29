/**
 * Lazy connect with IN-FLIGHT dedupe.
 *
 * The sandbox exec client connects on first use (connectSandbox polls for a
 * Ready pod, up to ~90s). A burst of concurrent first tool calls must share ONE
 * connect, not run N independent pod-readiness waits.
 *
 * `real ??= await connect()` does NOT dedupe: `??=` only caches the *resolved*
 * value, so concurrent awaits all see `undefined` and each call connect. We
 * memoize the *promise* instead. On failure we clear it, so a transient
 * pod-not-ready error doesn't permanently wedge the conversation — the next call
 * retries.
 */

export function createDeferredConnector<T>(connect: () => Promise<T>): () => Promise<T> {
  let resolved: T | undefined;
  let pending: Promise<T> | undefined;

  return async function ensure(): Promise<T> {
    if (resolved !== undefined) return resolved;
    if (pending) return pending;
    pending = (async () => {
      try {
        const value = await connect();
        resolved = value;
        return value;
      } finally {
        // Clear the in-flight slot: on success `resolved` now short-circuits;
        // on failure the next call re-attempts a fresh connect.
        pending = undefined;
      }
    })();
    return pending;
  };
}
