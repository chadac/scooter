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
import { groupModelsByProvider } from "./modelGroups.js";
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

  // A conversation's model is EITHER explicitly picked here OR inherited from the
  // host default. Distinguish them: an unset conversation SHOWS the default (so the
  // select has a value), but we mark it as inherited — otherwise every conversation
  // you never switched looks identically "set" to the default, which reads as "they
  // all changed to it" after you switch one. The value is still per-conversation
  // (proven: switching one never touches another); this is purely the display.
  const explicitModel = sessions.find((s) => s.id === currentId)?.model;
  const current = explicitModel ?? catalog.default ?? "";
  const inherited = explicitModel === undefined;

  return (
    // Lives INSIDE the composer's action row (next to ＋), so it's a compact,
    // borderless inline pill rather than a labelled row above the input. PR #465.
    <div className="aui-model-picker flex items-center gap-1 text-xs text-muted-foreground">
      <label htmlFor="aui-model-select" className="sr-only">Model</label>
      <select
        id="aui-model-select"
        aria-label="Model"
        data-testid="model-picker"
        data-inherited={inherited || undefined}
        // Muted/italic while inheriting the default (not an explicit pick), so a
        // never-switched conversation is visually distinct from one you set.
        className={
          "rounded-md border-0 bg-transparent px-1.5 py-1 hover:bg-accent focus:bg-accent focus:outline-none cursor-pointer " +
          (inherited ? "italic text-muted-foreground" : "text-foreground")
        }
        title={inherited ? "Using the host default (not set for this conversation)" : "Model set for this conversation"}
        value={current}
        onChange={(e) => {
          if (e.target.value !== current) setSwitching(true);
          sessionStore.setModel(currentId, e.target.value);
        }}
      >
        {(() => {
          const label = (m: string) => `${m}${m === catalog.default ? " (default)" : ""}`;
          // Two-level view when the catalog tags models with a source provider: group
          // each model under its provider ("byoc › claude-opus-4-8"), so the source is
          // obvious. Falls back to a flat list when no model is tagged (legacy catalogs).
          const groups = groupModelsByProvider(catalog.available, catalog.providers, catalog.default);
          if (!groups) {
            return catalog.available.map((m) => (
              <option key={m} value={m}>{label(m)}</option>
            ));
          }
          return groups.map((g) => (
            <optgroup key={g.provider} label={g.label} data-testid={`model-group-${g.provider}`}>
              {g.models.map((m) => (
                // A model two providers offer appears under each group; the value is
                // still the model id, so keys must be provider-scoped to stay unique.
                <option key={`${g.provider}:${m}`} value={m}>{label(m)}</option>
              ))}
            </optgroup>
          ));
        })()}
      </select>
      {inherited && !switching && (
        <span data-testid="model-inherited" className="text-[10px] uppercase tracking-wide opacity-60" title="Using the host default — not explicitly set for this conversation">
          inherited
        </span>
      )}
      {switching && (
        <span data-testid="model-switching" className="flex items-center gap-1" title="Applying the model change">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" aria-hidden />
          switching…
        </span>
      )}
    </div>
  );
}
