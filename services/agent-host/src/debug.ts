/**
 * Tiny debug logger gated by DEBUG/AGENT_HOST_DEBUG. Off by default so the
 * agent-host stays quiet in prod; set DEBUG=1 (or AGENT_HOST_DEBUG=1) to get the
 * [bridge]/[acp]/[exec] traces that are invaluable for diagnosing the ACP <->
 * sandbox path.
 */
const ON = process.env.DEBUG === "1" || process.env.AGENT_HOST_DEBUG === "1";

export const debug = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  if (ON) console.log(...args);
};

/** Errors that aren't fatal but are worth surfacing — always logged. */
export const debugError = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error(...args);
};
