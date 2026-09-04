/**
 * Fake agent-sandbox runtime API — in-memory implementation of the :8888
 * contract, for Tier 1 ExecBackend tests.
 */

import type { ExecRequest, ExecResult } from "../../src/types.js";
import type { SandboxApiClient } from "../../src/exec/sandboxExec.js";

export interface FakeSandboxApi extends SandboxApiClient {
  setFile(path: string, content: string): void;
  getFile(path: string): string | undefined;
  readonly executed: Array<{ command: string; args: string[] }>;
  /** Binary uploads (writeBinaryFile → uploadBinary): {path, base64}. */
  readonly uploadedBinary: Array<{ path: string; base64: string }>;
  whenExecute(
    handler: (command: string, args: string[]) => ExecResult,
  ): void;
  /** Make the next uploadBinary throw (to exercise best-effort write failure). */
  failUploadBinary(err?: Error): void;
}

export function createFakeSandboxApi(): FakeSandboxApi {
  const files = new Map<string, string>();
  const executed: Array<{ command: string; args: string[] }> = [];
  const uploadedBinary: Array<{ path: string; base64: string }> = [];
  let uploadBinaryError: Error | undefined;
  let handler: (command: string, args: string[]) => ExecResult = () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });

  return {
    mode: "direct",
    executed,
    uploadedBinary,
    failUploadBinary(err) {
      uploadBinaryError = err ?? new Error("uploadBinary failed");
    },
    setFile(path, content) {
      files.set(path, content);
    },
    getFile(path) {
      return files.get(path);
    },
    whenExecute(h) {
      handler = h;
    },
    async execute(req: ExecRequest): Promise<ExecResult> {
      executed.push({ command: req.command, args: req.args });
      return handler(req.command, req.args);
    },
    async download(path: string): Promise<string> {
      const content = files.get(path);
      if (content === undefined) throw new Error(`no such file: ${path}`);
      return content;
    },
    async upload(path: string, content: string): Promise<void> {
      files.set(path, content);
    },
    async uploadBinary(path: string, base64: string): Promise<void> {
      if (uploadBinaryError) {
        const e = uploadBinaryError;
        uploadBinaryError = undefined;
        throw e;
      }
      uploadedBinary.push({ path, base64 });
      files.set(path, Buffer.from(base64, "base64").toString("binary"));
    },
  };
}
