/**
 * Per-conversation model picker. Fetches the agent-host's model catalog
 * (GET /models) once, and lets the user choose the model for the CURRENT
 * conversation. The choice is stored on the session (sessions.ts) and rides the
 * next prompt via the X-Agent-Model header (RuntimeProvider), so it works both
 * at new-chat time and as a mid-conversation switch.
 *
 * Hidden entirely when the server offers no models (single-model deployments).
 * A plain styled <select> — reliable to drive in e2e and zero extra deps.
 */

import { useEffect, useRef, useState } from "react";

import { loadModels, type ModelCatalog } from "./client.js";
import { sessionStore, useSessions } from "./sessions.js";
import { useConversationInterrupts } from "./RuntimeProvider.js";

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

export function ModelPicker() {
  const { sessions, currentId } = useSessions();
  const { isRunning } = useConversationInterrupts();
  const [catalog, setCatalog] = useState<ModelCatalog>({ default: null, available: [] });
  // "switching" is true from the moment the user picks a new model until the next
  // run FINISHES — the server rebuilds goose with the new GOOSE_MODEL on that run
  // (a few seconds), and close() now waits for the old process to fully exit, so a
  // brief spinner tells the user the switch is in progress. Cleared when a run that
  // started while switching completes (isRunning true -> false).
  const [switching, setSwitching] = useState(false);
  const wasRunning = useRef(false);

  useEffect(() => {
    let alive = true;
    void loadModels({ baseUrl: BASE_URL }).then((c) => {
      if (alive) setCatalog(c);
    });
    return () => {
      alive = false;
    };
  }, []);

  // A run that began while switching has now finished -> the switch took effect.
  useEffect(() => {
    if (wasRunning.current && !isRunning) setSwitching(false);
    wasRunning.current = isRunning;
  }, [isRunning]);

  // Clear the pending switch when the conversation changes (it's per-conversation).
  useEffect(() => setSwitching(false), [currentId]);

  // Nothing (or only one option) to choose from -> don't show the picker.
  if (catalog.available.length <= 1) return null;

  const current = sessions.find((s) => s.id === currentId)?.model ?? catalog.default ?? "";

  return (
    <div className="aui-model-picker flex items-center justify-end gap-2 px-2 text-xs text-muted-foreground">
      <label htmlFor="aui-model-select">Model</label>
      <select
        id="aui-model-select"
        aria-label="Model"
        data-testid="model-picker"
        className="rounded-md border border-border bg-background px-2 py-1 text-foreground"
        value={current}
        onChange={(e) => {
          if (e.target.value !== current) setSwitching(true);
          sessionStore.setModel(currentId, e.target.value);
        }}
      >
        {catalog.available.map((m) => (
          <option key={m} value={m}>
            {m}
            {m === catalog.default ? " (default)" : ""}
          </option>
        ))}
      </select>
      {switching && (
        <span data-testid="model-switching" className="flex items-center gap-1" title="Applying the model change">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" aria-hidden />
          switching…
        </span>
      )}
    </div>
  );
}
