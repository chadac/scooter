/** Sandbox file writes create missing parent directories, text and binary alike. */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeStdinCommand } from "../../src/exec/k8sExec.js";

function run(argv: string[], input: string) {
  const [cmd, ...args] = argv;
  return spawnSync(cmd!, args, { input, encoding: "utf8" });
}

describe("writeStdinCommand", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "write-stdin-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("writes text into a directory that does not exist yet", () => {
    const path = join(root, "designs", "new dir", "it's.md");
    const res = run(writeStdinCommand(path), "# Title\nbody\n");
    expect(res.status, res.stderr).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("# Title\nbody\n");
  });

  it("overwrites an existing file", () => {
    const path = join(root, "a.txt");
    run(writeStdinCommand(path), "first, and longer");
    expect(run(writeStdinCommand(path), "second").status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("second");
  });

  it("decodes base64 into a fresh nested path", () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x89]);
    const path = join(root, "uploads", "x.bin");
    const res = run(writeStdinCommand(path, "base64 -d"), bytes.toString("base64"));
    expect(res.status, res.stderr).toBe(0);
    expect(readFileSync(path)).toEqual(bytes);
  });
});
