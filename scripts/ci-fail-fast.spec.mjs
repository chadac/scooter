// Guards ci.yml's merge-queue fail-fast: required producers cancel the run when red.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);

/** The text of one top-level job, from its key to the next job's key. */
function job(id) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${id}:`);
  expect(start, `job ${id} exists`).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}[a-z0-9-]+:$/.test(l));
  return rest.slice(0, end === -1 ? undefined : end).join("\n");
}

// The jobs whose failure fails a blocking gate in the merge queue.
const producers = [
  "fast",
  "image-build",
  "db-migrations",
  "nixos-test",
  "cluster-image-boot",
  "cluster-userns",
  "example-manifests",
  "e2e-shard",
  "e2e-full-shard",
];

describe("ci.yml merge-queue fail-fast", () => {
  it.each(producers)(
    "%s cancels the run when it fails in the merge queue",
    (id) => {
      const body = job(id);
      expect(body).toMatch(
        /- name: fail fast \(merge queue\)\n\s+if: failure\(\) && github\.event_name == 'merge_group'\n\s+uses: \.\/\.github\/actions\/cancel-run/,
      );
      expect(body).toMatch(/permissions:\n(\s{6}.+\n)*\s{6}actions: write/);
    },
  );

  it("never cancels from a reporting job or the summary, which must run after a cancel", () => {
    for (const id of [
      "fast-report",
      "nixos-report",
      "e2e-collect",
      "ci-summary",
    ]) {
      expect(job(id)).not.toContain("cancel-run");
    }
  });
});
