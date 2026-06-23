/**
 * Fake agent-sandbox runtime API — in-memory implementation of the :8888
 * contract, for Tier 1 ExecBackend tests.
 *
 * Design stage: test-double spec.
 */

import type { SandboxApiClient } from "../../src/exec/sandboxExec.js";

export interface FakeSandboxApi extends SandboxApiClient {
  /** Seed / inspect the fake filesystem. */
  setFile(path: string, content: string): void;
  getFile(path: string): string | undefined;
  /** Record of commands the ExecBackend forwarded. */
  readonly executed: Array<{ command: string; args: string[] }>;
  /** Make the next execute() return a canned result. */
  whenExecute(handler: (command: string, args: string[]) => { stdout: string; stderr: string; exitCode: number }): void;
}

export declare function createFakeSandboxApi(): FakeSandboxApi;
