/**
 * Settings page — Scheduled Tasks + Users.
 *
 * A scheduled task cron-spawns a fresh Scooter conversation with a prompt (the
 * scheduler service). This page lists the signed-in user's tasks and lets them
 * create / enable-disable / edit / delete them, proxied through the agent-host's
 * /scheduled-tasks routes (scoped to the caller). When the scheduler isn't
 * deployed, it shows a "not configured" note instead.
 *
 * The Users section lists the learned Scooter users (from the identity store);
 * it likewise shows a "not configured" note when no identity store is wired.
 */

import { useCallback, useEffect, useState } from "react";

import { agentHostConfig } from "./config.js";
import {
  loadScheduledTasks,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  loadUsers,
  searchModules,
  type ScheduledTaskView,
  type ScheduledTaskInput,
  type UserView,
  type RegistryModule,
} from "./client.js";
import { useSessions } from "./sessions.js";
import { viewStore } from "./view.js";

const BLANK: ScheduledTaskInput = { title: "", prompt: "", cron: "", timezone: "UTC", enabled: true };

/** The create / edit form. `initial` seeds edit mode; onDone closes it. */
function TaskForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: ScheduledTaskInput;
  submitLabel: string;
  onSubmit: (input: ScheduledTaskInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ScheduledTaskInput>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof ScheduledTaskInput>(k: K, v: ScheduledTaskInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ ...form, title: form.title.trim(), prompt: form.prompt.trim(), cron: form.cron.trim() });
    } catch (e) {
      setError((e as Error)?.message ?? "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const valid = form.title.trim() && form.prompt.trim() && form.cron.trim();

  return (
    <div data-testid="task-form" className="flex flex-col gap-3 rounded-md border bg-muted/30 p-4">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">Title</label>
        <input
          data-testid="task-title"
          value={form.title}
          onChange={(e) => set("title", e.target.value)}
          placeholder="Morning dashboard check"
          className="rounded-md border bg-background px-2 py-1.5 text-sm"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">Prompt</label>
        <textarea
          data-testid="task-prompt"
          value={form.prompt}
          onChange={(e) => set("prompt", e.target.value)}
          placeholder="Check the CI dashboard and post a summary of anything red."
          rows={3}
          className="rounded-md border bg-background px-2 py-1.5 text-sm"
        />
      </div>
      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">Schedule (cron)</label>
          <input
            data-testid="task-cron"
            value={form.cron}
            onChange={(e) => set("cron", e.target.value)}
            placeholder="0 9 * * 1-5"
            className="rounded-md border bg-background px-2 py-1.5 font-mono text-sm"
          />
          <span className="text-[11px] text-muted-foreground">5 fields: min hour dom mon dow — e.g. “0 9 * * 1-5” = 9am on weekdays.</span>
        </div>
        <div className="flex w-48 flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">Timezone</label>
          <input
            data-testid="task-timezone"
            value={form.timezone ?? "UTC"}
            onChange={(e) => set("timezone", e.target.value)}
            placeholder="UTC"
            className="rounded-md border bg-background px-2 py-1.5 text-sm"
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          data-testid="task-enabled"
          type="checkbox"
          checked={form.enabled ?? true}
          onChange={(e) => set("enabled", e.target.checked)}
        />
        Enabled
      </label>
      {error && <p data-testid="task-form-error" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <button
          data-testid="task-submit"
          disabled={!valid || busy}
          onClick={submit}
          className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-50"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
        <button data-testid="task-cancel" onClick={onCancel} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One task row — summary + enable toggle, edit, delete. */
function TaskRow({
  task,
  onChanged,
}: {
  task: ScheduledTaskView;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    setBusy(true);
    try {
      await updateScheduledTask(agentHostConfig, task.id, { enabled: !task.enabled });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete scheduled task “${task.title}”?`)) return;
    setBusy(true);
    try {
      await deleteScheduledTask(agentHostConfig, task.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <li data-testid="task-item" className="list-none">
        <TaskForm
          initial={{ title: task.title, prompt: task.prompt, cron: task.cron, timezone: task.timezone, enabled: task.enabled }}
          submitLabel="Save changes"
          onCancel={() => setEditing(false)}
          onSubmit={async (input) => {
            await updateScheduledTask(agentHostConfig, task.id, input);
            setEditing(false);
            onChanged();
          }}
        />
      </li>
    );
  }

  return (
    <li data-testid="task-item" data-enabled={task.enabled} className="flex list-none items-start gap-3 rounded-md border p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span data-testid="task-item-title" className="truncate font-medium">{task.title}</span>
          <span
            className={
              "rounded px-1.5 py-0.5 text-[10px] " +
              (task.enabled ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground")
            }
          >
            {task.enabled ? "enabled" : "disabled"}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span className="font-mono">{task.cron}</span>
          <span>{task.timezone}</span>
          {task.next_run_at && <span>next: {new Date(task.next_run_at).toLocaleString()}</span>}
          {task.last_run_at && <span>last: {new Date(task.last_run_at).toLocaleString()}</span>}
        </div>
        <p className="mt-1 line-clamp-2 text-sm text-foreground/80">{task.prompt}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          data-testid="task-toggle"
          disabled={busy}
          onClick={toggle}
          title={task.enabled ? "Disable" : "Enable"}
          className="rounded-md border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
        >
          {task.enabled ? "Disable" : "Enable"}
        </button>
        <button
          data-testid="task-edit"
          disabled={busy}
          onClick={() => setEditing(true)}
          className="rounded-md border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
        >
          Edit
        </button>
        <button
          data-testid="task-delete"
          disabled={busy}
          onClick={remove}
          aria-label={`Delete ${task.title}`}
          className="rounded-md border px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
        >
          Delete
        </button>
      </div>
    </li>
  );
}

/** The Users section — the learned Scooter users (signed-in / webhook-mapped).
 *  Hidden with a "not configured" note when no identity store is wired (501). */
function UsersSection() {
  const [users, setUsers] = useState<UserView[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const res = await loadUsers(agentHostConfig);
      setConfigured(res.configured);
      setUsers(res.users);
      setLoading(false);
    })();
  }, []);

  return (
    <section data-testid="users-section" className="flex flex-col gap-3">
      <div>
        <h2 className="font-medium">Users</h2>
        <p className="text-sm text-muted-foreground">
          People who’ve signed in to Scooter (learned as they arrive — not a full roster).
        </p>
      </div>

      {!configured ? (
        <p data-testid="users-unavailable" className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
          No identity store is configured, so users aren’t tracked here.
        </p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : users.length === 0 ? (
        <p data-testid="users-empty" className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
          No users seen yet.
        </p>
      ) : (
        <ul data-testid="user-list" className="flex flex-col gap-2">
          {users.map((u) => (
            <li
              key={u.id}
              data-testid="user-item"
              className="flex items-start justify-between gap-3 rounded-md border p-3"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{u.name || u.email || u.id}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  {u.email && <span className="truncate">{u.email}</span>}
                  <span className="font-mono">{u.id}</span>
                </div>
              </div>
              {u.updatedAt && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  last seen {new Date(u.updatedAt).toLocaleDateString()}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Available modules — the public registry catalog (read-only list here; install is
 *  on the Sandbox tab, since it runs in-pod). Uses the current conversation to reach
 *  the registry (it execs the in-pod broker CLI). */
function ModulesSettingsSection() {
  const { currentId } = useSessions();
  const [modules, setModules] = useState<RegistryModule[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      if (!currentId) { setAvailable(false); setLoading(false); return; }
      const res = await searchModules(agentHostConfig, currentId, "");
      setAvailable(res.configured);
      // Settings shows the shared catalog — public modules only.
      setModules(res.modules.filter((m) => m.visibility === "public"));
      setLoading(false);
    })();
  }, [currentId]);

  return (
    <section data-testid="modules-settings-section" className="flex flex-col gap-3">
      <div>
        <h2 className="font-medium">Available modules</h2>
        <p className="text-sm text-muted-foreground">
          Public Nix modules from the registry. Install them into a conversation from its Sandbox tab.
        </p>
      </div>

      {!available ? (
        <p data-testid="modules-settings-unavailable" className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
          {currentId
            ? "The module registry isn’t available for this conversation (start its sandbox to browse)."
            : "Open a conversation to browse available modules."}
        </p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : modules.length === 0 ? (
        <p data-testid="modules-settings-empty" className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
          No public modules published yet.
        </p>
      ) : (
        <ul data-testid="modules-settings-list" className="flex flex-col gap-2">
          {modules.map((m) => (
            <li key={m.id} data-testid="modules-settings-item" className="rounded-md border p-3">
              <div className="font-medium">{m.name}</div>
              {m.description && <p className="mt-0.5 text-sm text-muted-foreground">{m.description}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SettingsPage() {
  const [tasks, setTasks] = useState<ScheduledTaskView[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    const res = await loadScheduledTasks(agentHostConfig);
    setConfigured(res.configured);
    setTasks(res.tasks);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div data-testid="settings-page" className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 overflow-y-auto p-6">
      <div className="flex items-center gap-3">
        <button
          data-testid="settings-back"
          onClick={() => viewStore.set("chat")}
          className="rounded-md border px-2 py-1 text-sm hover:bg-accent"
        >
          ← Back
        </button>
        <h1 className="text-lg font-semibold">Settings</h1>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-medium">Scheduled tasks</h2>
            <p className="text-sm text-muted-foreground">
              Run a prompt on a schedule — each run starts a fresh conversation.
            </p>
          </div>
          {configured && !creating && (
            <button
              data-testid="task-new"
              onClick={() => setCreating(true)}
              className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background"
            >
              + New task
            </button>
          )}
        </div>

        {!configured ? (
          <p data-testid="scheduler-unavailable" className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
            The scheduler service isn’t deployed, so scheduled tasks aren’t available here.
          </p>
        ) : (
          <>
            {creating && (
              <TaskForm
                initial={BLANK}
                submitLabel="Create task"
                onCancel={() => setCreating(false)}
                onSubmit={async (input) => {
                  await createScheduledTask(agentHostConfig, input);
                  setCreating(false);
                  await refresh();
                }}
              />
            )}

            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : tasks.length === 0 ? (
              <p data-testid="tasks-empty" className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
                No scheduled tasks yet. Create one, or ask Scooter to set one up for you.
              </p>
            ) : (
              <ul data-testid="task-list" className="flex flex-col gap-2">
                {tasks.map((t) => (
                  <TaskRow key={t.id} task={t} onChanged={refresh} />
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <UsersSection />

      <ModulesSettingsSection />
    </div>
  );
}
