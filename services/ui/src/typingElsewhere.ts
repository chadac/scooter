import { useSyncExternalStore } from "react";

/** Whether focus is in a text field or open popup outside the composer. */
export function typingElsewhere(el: Element | null): boolean {
  if (!(el instanceof HTMLElement) || el.closest(".aui-composer-root")) return false;
  // Taking focus from a popover or menu closes it.
  if (el.closest('[role="dialog"], [role="menu"]')) return true;
  return el.isContentEditable || el instanceof HTMLTextAreaElement
    || (el instanceof HTMLInputElement && TEXT_TYPES.has(el.type));
}

const TEXT_TYPES = new Set(["text", "search", "email", "url", "tel", "number", "password"]);

function subscribe(cb: () => void): () => void {
  document.addEventListener("focusin", cb);
  document.addEventListener("focusout", cb);
  return () => {
    document.removeEventListener("focusin", cb);
    document.removeEventListener("focusout", cb);
  };
}

/** Re-renders when focus moves; true while the user types outside the composer. */
export function useTypingElsewhere(): boolean {
  return useSyncExternalStore(subscribe, () => typingElsewhere(document.activeElement), () => false);
}
