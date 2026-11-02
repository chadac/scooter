/**
 * Build an assistant-ui `ExportedMessageRepository` from our folded message list
 * for the incremental external-store render path, which reconciles per message and
 * keeps unchanged subtrees in place.
 *
 * Two invariants the reconcile requires: message ids are stable across pushes
 * (log-derived or the deterministic `sys:` splice, never per-render), and messages
 * are chained linearly parent-before-child with the last message as head.
 */

import { fromAgUiMessages } from "@assistant-ui/react-ag-ui";
import { ExportedMessageRepository } from "@assistant-ui/react";

/** A repository snapshot the external store consumes: a flat, parent-linked list plus the head. */
export type RepositorySnapshot = ExportedMessageRepository;

/** An image attached to a user message, as carried by a MESSAGE_IMAGES event. */
export interface MessageImageRef {
  assetId: string;
  mimeType: string;
  /** Root-absolute assets route the server emits: /conversations/:id/assets/:assetId. */
  url: string;
}

/**
 * Append each user message's attached images (MESSAGE_IMAGES rides the log but the
 * base applier ignores it) in the AG-UI wire shape `{type:"image", source:{type:"url", value}}`,
 * the only shape fromAgUiMessages keeps as an attachment, with `baseUrl` prefixed so
 * the <img> resolves through the same API base as every other request.
 */
export function enrichMessagesWithImages(
  foldedMessages: readonly unknown[],
  getImages: (messageId: string) => readonly MessageImageRef[] | undefined,
  baseUrl: string,
): unknown[] {
  return foldedMessages.map((m) => {
    const msg = m as { id?: string; role?: string; content?: unknown };
    // An assistant message's images are attached after conversion (attachAssistantImages).
    if (msg.role === "assistant") return m;
    const imgs = msg.id ? getImages(msg.id) : undefined;
    if (!imgs?.length) return m;
    const parts = Array.isArray(msg.content)
      ? [...(msg.content as unknown[])]
      : msg.content
        ? [{ type: "text", text: msg.content }]
        : [];
    for (const img of imgs) {
      parts.push({ type: "image", source: { type: "url", value: baseUrl + img.url, mimeType: img.mimeType } });
    }
    return { ...msg, content: parts };
  });
}

/**
 * Append each assistant message's images as `{type:"file", mimeType:"image/…", data:<url>}` parts.
 * fromAgUiMessages keeps images only as user attachments, so the ones an agent sent
 * (MESSAGE_IMAGES on an assistant message) are added to the converted message instead.
 */
export function attachAssistantImages<T>(
  converted: T[],
  getImages: (messageId: string) => readonly MessageImageRef[] | undefined,
  baseUrl: string,
): T[] {
  return converted.map((m) => {
    const msg = m as { id?: string; role?: string; content?: unknown };
    if (msg.role !== "assistant" || !msg.id) return m;
    const imgs = getImages(msg.id);
    if (!imgs?.length) return m;
    const parts: unknown[] = Array.isArray(msg.content)
      ? [...(msg.content as unknown[])]
      : typeof msg.content === "string" && msg.content
        ? [{ type: "text", text: msg.content }]
        : [];
    // A file part, not an image part: assistant-ui drops an image part whose URL is not
    // https:, blob: or data:, which a root-relative assets path is not.
    for (const img of imgs) parts.push({ type: "file", mimeType: img.mimeType, data: baseUrl + img.url, filename: img.assetId });
    return { ...m, content: parts };
  });
}


/** Where a message's send time (epoch ms) rides on the converted message, read by MessageTimestamp. */
export const SENT_AT_KEY = "sentAt";

/**
 * Stamp each converted message with its send time as both `createdAt` and
 * `metadata.custom.sentAt`. The custom key is what the UI reads, because assistant-ui
 * defaults a missing `createdAt` to "now", which would show a wrong time.
 */
function withSentAt<T>(messages: T[], timeOf?: (messageId: string) => number | undefined): T[] {
  if (!timeOf) return messages;
  return messages.map((m) => {
    const msg = m as { id?: string; metadata?: { custom?: Record<string, unknown> } };
    if (!msg.id) return m;
    // An orphan tool result converts to `<id>:assistant`; look up the id it came from.
    const t = timeOf(msg.id) ?? timeOf(msg.id.replace(/:assistant$/, ""));
    if (t === undefined) return m;
    return {
      ...m,
      createdAt: new Date(t),
      metadata: { ...msg.metadata, custom: { ...msg.metadata?.custom, [SENT_AT_KEY]: t } },
    };
  });
}

/**
 * Convert the folded AG-UI message array into an ExportedMessageRepository with a
 * linear parent chain, via `fromBranchableArray` so ids are preserved, returning a
 * new object each call because the external store skips the reconcile when handed
 * the same reference.
 */
export function toRepositorySnapshot(
  foldedMessages: readonly unknown[],
  timeOf?: (messageId: string) => number | undefined,
  assistantImages?: { get: (messageId: string) => readonly MessageImageRef[] | undefined; baseUrl: string },
): RepositorySnapshot {
  let converted = fromAgUiMessages(foldedMessages as never[]);
  if (assistantImages) converted = attachAssistantImages(converted, assistantImages.get, assistantImages.baseUrl);
  const messages = withSentAt(converted, timeOf);
  // Dedupe by id: linking the same id twice throws inside fromBranchableArray during
  // render and blanks the whole page.
  const seen = new Set<string>();
  const unique = messages.filter((m) => {
    const id = (m as { id?: string }).id;
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const items = unique.map((message, i) => ({
    message,
    parentId: i > 0 ? (unique[i - 1] as { id: string }).id : null,
  }));
  const headId = unique.length ? (unique.at(-1) as { id: string }).id : null;
  return ExportedMessageRepository.fromBranchableArray(items, { headId });
}
