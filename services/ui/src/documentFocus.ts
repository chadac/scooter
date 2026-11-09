import { useSyncExternalStore } from "react";

function subscribe(cb: () => void): () => void {
  window.addEventListener("focus", cb);
  window.addEventListener("blur", cb);
  return () => {
    window.removeEventListener("focus", cb);
    window.removeEventListener("blur", cb);
  };
}

/** Whether this document has focus, rather than another frame or window. */
export function useDocumentFocused(): boolean {
  return useSyncExternalStore(subscribe, () => document.hasFocus(), () => true);
}

/** Whether this page is framed inside another page. */
export const embedded = typeof window !== "undefined" && window.self !== window.top;
