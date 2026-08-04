/**
 * A minimal external-store runtime for scooter's single-source render model.
 *
 * Replaces `useAgUiRuntime` for RENDERING. scooter does NOT let the react-ag-ui
 * runtime fold events (its per-run aggregator merges our multi-run integrity replay
 * wrong — see RuntimeProvider's header). Instead our IntegrityAgent folds the log and
 * we hand assistant-ui the result. The old path did `runtime.thread.reset(...)` on
 * every push, which REBUILDS the whole message repository (fresh ids, full re-paint —
 * the "open a conversation and it jumps/flashes" bug).
 *
 * Here we feed the external store a `messageRepository` SNAPSHOT instead. The core
 * reconciles per-message (add / keep-in-place / delete + resetHead), so unchanged
 * messages are NOT re-painted and the viewport stays pinned at the head. This is also
 * the foundation for load-earlier/prepend (older messages inserted above the head).
 *
 * Only the surface scooter actually uses is wired: the repository render, `onNew`
 * (the composer send), `isRunning`, and the thread-list + attachment adapters.
 * Interrupts / run-state come from the IntegrityAgent via context, NOT this runtime.
 */

import { useMemo } from "react";
import {
  useExternalStoreRuntime,
  type AppendMessage,
  type AttachmentAdapter,
  type ExternalStoreThreadListAdapter,
  type ThreadMessage,
} from "@assistant-ui/react";

import type { RepositorySnapshot } from "./messageRepository.js";

export interface RepositoryRuntimeOptions {
  /** The current message-repository snapshot (from toRepositorySnapshot). A NEW
   *  object each render with STABLE inner ids — the core skips the reconcile if the
   *  object is reference-equal to the previous one. */
  messageRepository: RepositorySnapshot;
  /** Whether a run is in flight (drives the composer's running state / Stop). */
  isRunning: boolean;
  /** The composer send. Receives the appended user message; we extract text +
   *  images and fire-and-forget it to the agent-host (see RuntimeProvider). */
  onNew: (message: AppendMessage) => Promise<void>;
  adapters?: {
    threadList?: ExternalStoreThreadListAdapter;
    attachments?: AttachmentAdapter;
  };
}

/**
 * Build the assistant-ui runtime from a message-repository snapshot. The store is
 * re-created each render (so the reconcile runs when the snapshot changes), but the
 * per-message reconcile is a no-op for messages whose ids didn't change.
 */
export function useRepositoryRuntime(options: RepositoryRuntimeOptions) {
  const { messageRepository, isRunning, onNew, adapters } = options;
  return useExternalStoreRuntime<ThreadMessage>(
    useMemo(
      () => ({
        // Repository (not flat `messages`) → the incremental reconcile path. Our items
        // are already ThreadMessage, so convertMessage is the identity (the store type
        // requires it, but the repository path never invokes it).
        convertMessage: (m: ThreadMessage) => m,
        messageRepository,
        isRunning,
        onNew,
        adapters: {
          threadList: adapters?.threadList,
          attachments: adapters?.attachments,
        },
      }),
      [messageRepository, isRunning, onNew, adapters?.threadList, adapters?.attachments],
    ),
  );
}
