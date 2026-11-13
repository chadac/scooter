/**
 * goose's spawn env carries the conversation owner as USER/LOGNAME and, for Langfuse, as
 * user.id / langfuse.user.id / langfuse.session.id resource attributes under Scooter's
 * service.namespace.
 */
import { describe, it, expect, afterEach } from "vitest";

import { catalogFromEnv } from "../../src/agent/models.js";
import { configFromEnv, gooseIdentityEnv, gooseLaunchEnv } from "../../src/index.js";

describe("gooseIdentityEnv", () => {
  it("puts the owner in USER, LOGNAME and the Langfuse resource attributes", () => {
    const catalog = catalogFromEnv({} as NodeJS.ProcessEnv);
    const env = {
      ...gooseLaunchEnv({ GOOSE_PROVIDER: "aws_bedrock" }, catalog, undefined),
      ...gooseIdentityEnv("ada@example.com", "conv-1", undefined),
    };
    expect(env.GOOSE_PROVIDER).toBe("aws_bedrock");
    expect(env.USER).toBe("ada@example.com");
    expect(env.LOGNAME).toBe("ada@example.com");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      "service.namespace=scooter,user.id=ada@example.com,langfuse.user.id=ada@example.com,langfuse.session.id=conv-1",
    );
  });

  it("appends to an existing OTEL_RESOURCE_ATTRIBUTES", () => {
    const env = gooseIdentityEnv("u1", "c1", "deployment.environment=prod");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      "deployment.environment=prod,service.namespace=scooter,user.id=u1,langfuse.user.id=u1,langfuse.session.id=c1",
    );
  });

  // goose's SDK splits on "," and does not percent-decode, so only "," and "%" are escaped.
  it("escapes a comma or percent in a value", () => {
    const attrs = gooseIdentityEnv("a,b%c=d", "c1", "").OTEL_RESOURCE_ATTRIBUTES.split(",");
    expect(attrs[1]).toBe("user.id=a%2Cb%25c=d");
  });
});

describe("configFromEnv agent", () => {
  const saved = process.env.GOOSE_BIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.GOOSE_BIN;
    else process.env.GOOSE_BIN = saved;
  });

  it("marks only the dummy agent as fake, so real goose gets the identity env", () => {
    process.env.GOOSE_BIN = "fake";
    expect(configFromEnv().agent.fake).toBe(true);
    process.env.GOOSE_BIN = "goose";
    expect(configFromEnv().agent.fake).toBeUndefined();
  });
});
