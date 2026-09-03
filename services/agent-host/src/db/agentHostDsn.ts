/**
 * The agent_host database DSN, assembled from the environment the platform wires.
 *
 * The agent-host Deployment and the one-shot event-backfill Job both connect to the SAME
 * database with the SAME credentials, so the DSN they use must be assembled identically — a
 * backfill that wrote to a different database/user than the live service reads from would
 * "succeed" while loading nothing anyone can see. Keeping this in one place is what makes the
 * two agree: index.ts (the service) and scripts/runEventBackfill.ts (the Job) both call it.
 *
 * Precedence matches the rest of agent-host: an explicit AGENT_HOST_DB_DSN wins; otherwise the
 * DSN is built from the discrete AGENT_HOST_DB_* vars the platform sets (host/port/name/user +
 * the password from the agent-pg-agent-host Secret). Returns "" when no password is present, so
 * a caller can distinguish "Postgres not configured" from a real connection failure.
 */

export function agentHostDsnFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AGENT_HOST_DB_DSN;
  if (explicit) return explicit;
  const pw = env.AGENT_HOST_DB_PASSWORD;
  if (!pw) return "";
  const host = env.AGENT_HOST_DB_HOST ?? "agent-shared-db";
  const port = env.AGENT_HOST_DB_PORT ?? "5432";
  const name = env.AGENT_HOST_DB_NAME ?? "agent_host";
  const user = env.AGENT_HOST_DB_USER ?? "agent_host";
  const sslmode = env.AGENT_HOST_DB_SSLMODE;
  const query = sslmode ? `?sslmode=${encodeURIComponent(sslmode)}` : "";
  return `postgresql://${user}:${encodeURIComponent(pw)}@${host}:${port}/${name}${query}`;
}
