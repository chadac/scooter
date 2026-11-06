// Guards .github/workflows/ci.yml's concurrency key against merges cancelling the nightly.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

describe("ci.yml concurrency", () => {
  it("keys the group by event, so a push to main cannot cancel the nightly run", () => {
    const group = workflow.match(/^concurrency:\n\s+group:\s*(.+)$/m)?.[1];
    expect(group).toBeDefined();
    expect(group).toContain("${{ github.event_name }}");
    expect(group).toContain("${{ github.ref }}");
  });
});
