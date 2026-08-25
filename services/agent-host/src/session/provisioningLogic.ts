/**
 * Async provisioning logic with retry — extracted to keep manager.ts clean.
 * Implements D3 (retry with backoff) and D2 (observable state).
 */

import type { SessionId, ThreadId, SandboxRef } from "../types.js";
import type { SandboxProvisioner } from "./manager.js";
import type { AguiEvent } from "../bridge.js";

export interface ProvisioningConfig {
  retryMax: number;
  retryBaseMs: number;
  retryCapMs: number;
}

export interface ProvisioningCallbacks {
  /** Update entry state and persist. */
  updateState: (update: {
    status?: "provisioning" | "ready" | "failed";
    sandbox?: SandboxRef;
    provisioningAttempt?: number;
    provisioningError?: string;
  }) => Promise<void>;
  /** Emit and persist an event. */
  emitEvent: (event: AguiEvent) => Promise<void>;
  /** Check if provisioning was cancelled (conversation deleted/ended). */
  isCancelled: () => boolean;
}

/**
 * Provision a conversation's sandbox with automatic retry.
 * Runs async after start() returns — does NOT block the caller.
 */
export async function provisionConversation(
  conversationId: string,
  threadId: ThreadId,
  provisioner: SandboxProvisioner,
  config: ProvisioningConfig,
  callbacks: ProvisioningCallbacks,
): Promise<void> {
  const { retryMax, retryBaseMs, retryCapMs } = config;
  const { updateState, emitEvent, isCancelled } = callbacks;

  // Emit PROVISIONING_STARTED
  await emitEvent({ type: "PROVISIONING_STARTED", threadId });

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= retryMax; attempt++) {
    if (isCancelled()) {
      // Conversation was deleted/ended during provisioning — stop trying.
      return;
    }

    try {
      // Update attempt counter
      await updateState({ status: "provisioning", provisioningAttempt: attempt });

      // Attempt to provision
      const sandbox = await provisioner.create(conversationId, threadId);

      // Success! Transition to ready.
      await updateState({
        status: "ready",
        sandbox,
        provisioningAttempt: undefined,
        provisioningError: undefined,
      });

      return; // Done
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Persist the error
      await updateState({
        provisioningAttempt: attempt,
        provisioningError: lastError.message,
      });

      if (attempt < retryMax) {
        // More attempts left — retry with backoff
        const delayMs = Math.min(retryBaseMs * 2 ** (attempt - 1), retryCapMs);

        await emitEvent({
          type: "PROVISIONING_RETRYING",
          threadId,
          attempt,
          max: retryMax,
          delayMs,
        });

        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        // Exhausted all attempts — transition to failed
        await updateState({
          status: "failed",
          provisioningAttempt: attempt,
          provisioningError: lastError.message,
        });

        await emitEvent({
          type: "PROVISIONING_ERROR",
          threadId,
          message: `Provisioning failed after ${retryMax} attempts: ${lastError.message}`,
          attempt: retryMax,
          max: retryMax,
        });
      }
    }
  }
}
