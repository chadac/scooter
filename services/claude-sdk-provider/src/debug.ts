/** Debug logger gated by DEBUG/AGENT_HOST_DEBUG (mirrors agent-host/src/debug.ts
 *  so this isolated package doesn't import from agent-host). */
const ON = process.env.DEBUG === "1" || process.env.AGENT_HOST_DEBUG === "1";
export const debug = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  if (ON) console.log(...args);
};
export const debugError = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error(...args);
};
