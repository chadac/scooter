import { RefreshCw, X } from "lucide-react";

import { updateStore, useUpdateState } from "./appUpdate.js";

/** Offers a reload once a newer build is deployed. */
export function UpdateBanner() {
  const { available, dismissed } = useUpdateState();
  if (!available || dismissed) return null;
  return (
    <div
      role="status"
      data-testid="update-banner"
      className="flex items-center gap-3 border-b bg-accent px-3 py-1.5 text-xs text-accent-foreground"
    >
      <span>Scooter has been updated.</span>
      <button
        type="button"
        data-testid="update-reload"
        onClick={() => globalThis.location.reload()}
        className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
      >
        <RefreshCw aria-hidden className="size-3.5" />
        Reload
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        data-testid="update-dismiss"
        onClick={() => updateStore.dismiss()}
        className="ms-auto leading-none opacity-70 hover:opacity-100"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
