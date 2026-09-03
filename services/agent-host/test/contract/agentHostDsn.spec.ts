/**
 * Tier 1 contract — the agent_host DSN builder shared by the live service (index.ts) and the
 * one-shot event-backfill Job (scripts/runEventBackfill.ts).
 *
 * These two MUST assemble the exact same connection string from the same env, or the backfill
 * writes to a different database/role than agent-host reads from — a "successful" migration that
 * loads nothing anyone can see. This pins the precedence + encoding both rely on.
 */

import { describe, it, expect } from "vitest";

import { agentHostDsnFromEnv } from "../../src/db/agentHostDsn.js";

describe("agentHostDsnFromEnv", () => {
  it("prefers an explicit AGENT_HOST_DB_DSN over the discrete vars", () => {
    const dsn = agentHostDsnFromEnv({
      AGENT_HOST_DB_DSN: "postgresql://explicit@host/db",
      AGENT_HOST_DB_PASSWORD: "ignored",
    } as NodeJS.ProcessEnv);
    expect(dsn).toBe("postgresql://explicit@host/db");
  });

  it("builds from the discrete AGENT_HOST_DB_* vars", () => {
    const dsn = agentHostDsnFromEnv({
      AGENT_HOST_DB_HOST: "agent-shared-db",
      AGENT_HOST_DB_PORT: "5432",
      AGENT_HOST_DB_NAME: "agent_host",
      AGENT_HOST_DB_USER: "agent_host",
      AGENT_HOST_DB_PASSWORD: "s3cret",
    } as NodeJS.ProcessEnv);
    expect(dsn).toBe("postgresql://agent_host:s3cret@agent-shared-db:5432/agent_host");
  });

  it("URL-encodes a password with reserved characters", () => {
    const dsn = agentHostDsnFromEnv({
      AGENT_HOST_DB_PASSWORD: "p@ss:w/rd?",
    } as NodeJS.ProcessEnv);
    // defaults fill host/port/name/user; the password is percent-encoded so the URL parses.
    expect(dsn).toBe("postgresql://agent_host:p%40ss%3Aw%2Frd%3F@agent-shared-db:5432/agent_host");
  });

  it("appends sslmode when set", () => {
    const dsn = agentHostDsnFromEnv({
      AGENT_HOST_DB_PASSWORD: "pw",
      AGENT_HOST_DB_HOST: "db",
      AGENT_HOST_DB_SSLMODE: "require",
    } as NodeJS.ProcessEnv);
    expect(dsn).toBe("postgresql://agent_host:pw@db:5432/agent_host?sslmode=require");
  });

  it("returns '' when no password is present (Postgres not configured)", () => {
    expect(agentHostDsnFromEnv({} as NodeJS.ProcessEnv)).toBe("");
  });
});
