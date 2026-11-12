/** Settings → Conversations: the default retention policy for unfiled conversations. */
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { loadUserRetention, saveUserRetention, type UserRetention } from "./client.js";
import { agentHostConfig } from "./config.js";
import { folderStore } from "./folders.js";
import { CustomLifetimeForm } from "./RetentionForm.js";
import { lifetimeChoices, lifetimeLabel } from "./retention.js";

export function RetentionSection() {
  const [state, setState] = useState<UserRetention | null>();
  const [customizing, setCustomizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void loadUserRetention(agentHostConfig).then(setState);
  }, []);

  const save = async (hours: number | null) => {
    if (!state) return;
    const prev = state;
    const next = { ...state, lifetimeHours: hours ?? undefined };
    setState(next);
    setCustomizing(false);
    const err = await saveUserRetention(agentHostConfig, hours);
    setError(err);
    if (err) return setState(prev);
    folderStore.setDefaultLifetime(hours ?? state.deploymentLifetimeHours);
  };

  const own = state?.lifetimeHours;
  const choices: Array<[number | null, string]> = [
    [null, `Deployment default (${lifetimeLabel(state?.deploymentLifetimeHours ?? 0)})`],
    ...lifetimeChoices(own),
  ];
  return (
    <section data-testid="retention-section" className="flex flex-col gap-3">
      <div>
        <h2 className="font-medium">Conversation retention policy</h2>
        <p className="text-sm text-muted-foreground">
          Conversations outside any folder are deleted once idle this long. A folder can set its own policy from its ⋯ menu,
          and starred conversations are always kept.
        </p>
      </div>
      {state === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !state?.configurable ? (
        <p className="text-sm text-muted-foreground">
          {state
            ? `This deployment keeps unfiled conversations for ${lifetimeLabel(state.deploymentLifetimeHours)}, and doesn't store a policy per user.`
            : "The retention policy couldn't be loaded."}
        </p>
      ) : (
        <>
          <div role="radiogroup" aria-label="Conversation retention policy" className="flex flex-wrap gap-1">
            {choices.map(([h, label]) => {
              const checked = !customizing && (h === null ? own === undefined : own === h);
              return (
                <Button
                  key={String(h)}
                  variant={checked ? "default" : "outline"}
                  size="sm"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => void save(h)}
                >
                  {label}
                </Button>
              );
            })}
            <Button variant={customizing ? "default" : "outline"} size="sm" onClick={() => setCustomizing(true)}>
              Custom…
            </Button>
          </div>
          {customizing && (
            <div className="w-fit rounded-md border p-2.5">
              <CustomLifetimeForm initialHours={own} onSave={(h) => void save(h)} onCancel={() => setCustomizing(false)} />
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
