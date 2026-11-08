// Runs e2e-target-pattern.sh as CI does, with a fake `gh`.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../.github/scripts/e2e-target-pattern.sh", import.meta.url),
);

/** Run the script; `pr` is the JSON the fake `gh api` returns. */
function run(env = {}, pr = null) {
  const dir = mkdtempSync(join(tmpdir(), "e2e-target-"));
  const out = join(dir, "github-output");
  writeFileSync(out, "");
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    pr === null
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\necho "$*" > "${dir}/gh-args"\ncat "${dir}/pr.json"\n`,
  );
  chmodSync(gh, 0o755);
  if (pr !== null) writeFileSync(join(dir, "pr.json"), JSON.stringify(pr));
  let ok = true;
  let log = "";
  try {
    log = execFileSync("bash", [script], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_OUTPUT: out,
        GITHUB_REPOSITORY: "chadac-me/scooter",
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    ok = false;
    log = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  const pattern = readFileSync(out, "utf8").match(/^pattern=(.*)$/m)?.[1];
  let ghArgs = "";
  try {
    ghArgs = readFileSync(join(dir, "gh-args"), "utf8").trim();
  } catch {}
  return { ok, pattern, log, ghArgs };
}

describe("on a pull request", () => {
  it("emits the pattern when labelled, stripping backticks and the CR", () => {
    const r = run({
      GITHUB_EVENT_NAME: "pull_request",
      LABELS: "full-ci,e2e-target",
      PR_BODY: "prose\r\ne2e-target: `renames a conversation|archives it`\r\nmore",
    });
    expect(r.ok).toBe(true);
    expect(r.pattern).toBe("renames a conversation|archives it");
  });

  it("skips an example inside a code fence", () => {
    const r = run({
      GITHUB_EVENT_NAME: "pull_request",
      LABELS: "e2e-target",
      PR_BODY: "```\r\ne2e-target: an example\r\n```\r\n\r\ne2e-target: the real one\r\n",
    });
    expect(r.ok).toBe(true);
    expect(r.pattern).toBe("the real one");
  });

  it("fails when the only line is inside a code fence", () => {
    const r = run({
      GITHUB_EVENT_NAME: "pull_request",
      LABELS: "e2e-target",
      PR_BODY: "~~~\ne2e-target: an example\n~~~\n",
    });
    expect(r.ok).toBe(false);
  });

  it("emits nothing without the label, even with the line", () => {
    const r = run({
      GITHUB_EVENT_NAME: "pull_request",
      LABELS: "e2e-target-x",
      PR_BODY: "e2e-target: something",
    });
    expect(r.ok).toBe(true);
    expect(r.pattern).toBe("");
  });

  it("fails loudly when labelled without the line", () => {
    const r = run({
      GITHUB_EVENT_NAME: "pull_request",
      LABELS: "e2e-target",
      PR_BODY: "no key here",
    });
    expect(r.ok).toBe(false);
    expect(r.log).toContain("has no");
  });
});

describe("in the merge queue", () => {
  const ref = "refs/heads/gh-readonly-queue/main/pr-1234-0123abcdef";

  it("reads the queued PR's labels and body", () => {
    const r = run(
      { GITHUB_EVENT_NAME: "merge_group", MERGE_GROUP_HEAD_REF: ref },
      { body: "e2e-target: new story", labels: [{ name: "e2e-target" }] },
    );
    expect(r.ok).toBe(true);
    expect(r.pattern).toBe("new story");
    expect(r.ghArgs).toBe("api repos/chadac-me/scooter/pulls/1234");
  });

  it("emits nothing when the queued PR is unlabelled", () => {
    const r = run(
      { GITHUB_EVENT_NAME: "merge_group", MERGE_GROUP_HEAD_REF: ref },
      { body: "e2e-target: new story", labels: [] },
    );
    expect(r.ok).toBe(true);
    expect(r.pattern).toBe("");
  });

  // Fail closed: a labelled PR must not merge untested.
  it("fails when the PR lookup fails", () => {
    const r = run({ GITHUB_EVENT_NAME: "merge_group", MERGE_GROUP_HEAD_REF: ref });
    expect(r.ok).toBe(false);
  });
});
