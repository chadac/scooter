/**
 * Controllable test provisioner — can be slow, can fail, tracks calls.
 * Replaces the noop provisioner for testing async provisioning behavior.
 */

import type { SandboxProvisioner, SandboxRef } from "../../src/session/manager.js";

export interface ControllableProvisionerConfig {
  /** Delay in ms before returning (simulates slow pod scheduling). */
  delayMs?: number;
  /** Number of times create() should fail before succeeding. */
  failCount?: number;
  /** If true, create() always fails (for testing exhaustion). */
  alwaysFail?: boolean;
  /** Custom error message for failures. */
  errorMessage?: string;
}

export class ControllableProvisioner implements SandboxProvisioner {
  private callCount = 0;
  private failedCount = 0;
  private config: ControllableProvisionerConfig;

  constructor(config: ControllableProvisionerConfig = {}) {
    this.config = config;
  }

  async create(conversationId: string, threadId?: string): Promise<SandboxRef> {
    this.callCount++;
    
    // Simulate delay (slow pod scheduling)
    if (this.config.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.config.delayMs));
    }

    // Fail if configured to
    if (this.config.alwaysFail || (this.config.failCount && this.failedCount < this.config.failCount)) {
      this.failedCount++;
      throw new Error(this.config.errorMessage ?? `Provisioning failed (attempt ${this.callCount})`);
    }

    // Success
    return { name: `test-${conversationId}`, namespace: "test" };
  }

  async suspend(_ref: SandboxRef): Promise<void> {
    // noop for tests
  }

  async resume(ref: SandboxRef): Promise<SandboxRef> {
    return ref;
  }

  async destroy(_ref: SandboxRef): Promise<void> {
    // noop for tests
  }

  // Test helpers
  getCallCount(): number {
    return this.callCount;
  }

  getFailedCount(): number {
    return this.failedCount;
  }

  reset(): void {
    this.callCount = 0;
    this.failedCount = 0;
  }

  setConfig(config: ControllableProvisionerConfig): void {
    this.config = { ...this.config, ...config };
  }
}
