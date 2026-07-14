/**
 * Broker auth headers (the agent-host's own SA token) — shared by every agent-host
 * -> broker CONTROL call (AWS approve/deny, and the sandbox lifecycle client). The
 * agent-host presents its projected SA token; the broker TokenReviews it and
 * authorizes it as a control caller (SANDBOX_CONTROL_SERVICE_ACCOUNTS).
 *
 * A MISSING token (ENOENT) is the local/dev case (no auth header); any OTHER read
 * error is surfaced — never send an unauthenticated request pretending it's fine.
 */

export async function brokerAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const tokenPath = process.env.BROKER_TOKEN_PATH ?? "/var/run/secrets/broker/token";
  try {
    const { readFileSync } = await import("node:fs");
    headers["Authorization"] = `Bearer ${readFileSync(tokenPath, "utf8").trim()}`;
  } catch (e) {
    if ((e as { code?: string })?.code !== "ENOENT") {
      throw new Error(`failed to read broker token at ${tokenPath}: ${(e as Error)?.message ?? e}`, { cause: e });
    }
  }
  return headers;
}
