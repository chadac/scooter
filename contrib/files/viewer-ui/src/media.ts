import { useEffect, useState, useSyncExternalStore } from "react";

/** Tracks a media query, re-rendering when it flips. */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const update = () => setOn(m.matches);
    update();
    m.addEventListener("change", update);
    return () => m.removeEventListener("change", update);
  }, [query]);
  return on;
}

// Tailwind's `md`: below it the tree and comments become overlays.
export const useNarrow = () => useMedia("(max-width: 767.98px)");

const darkNow = () => document.documentElement.classList.contains("dark");
function onRootClass(cb: () => void) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => obs.disconnect();
}

/** Whether the page shows its dark theme, as the theme toggle set it. */
export const useDarkTheme = () => useSyncExternalStore(onRootClass, darkNow);
