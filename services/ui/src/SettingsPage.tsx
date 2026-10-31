/**
 * Settings page: the Scheduled Tasks, Skills, Bring Your Own Claude and Admin tabs.
 *
 * A scheduled task cron-spawns a fresh Scooter conversation with a prompt via the
 * scheduler service, proxied through the agent-host's /scheduled-tasks routes and
 * scoped to the caller. A personal skill is markdown the caller writes here and the agent
 * loads next to the deployment's built-in skills at the start of their conversations. Each
 * section shows a "not configured" note when its backing service is not deployed.
 */

import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import { ArrowLeft, Check, ChevronRight } from "@/icons";

import { agentHostConfig } from "./config.js";
import { loadDevices, deregisterDevice, formatLastSeen, type ByocDevice } from "./byocDevices.js";
import {
  loadScheduledTasks,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  loadUsers,
  loadUserSkills,
  createUserSkill,
  updateUserSkill,
  deleteUserSkill,
  loadUserHooks,
  setUserHookEnabled,
  loadRemoteAgentStatus,
  requestRemoteAgentJoinToken,
  type ScheduledTaskView,
  type ScheduledTaskInput,
  type UserView,
  type UserSkillView,
  type UserSkillInput,
  type UserHookView,
} from "./client.js";
import { viewStore, useSettingsTab, settingsTabList, resolveTab, isBuiltinTab, type BuiltinTab } from "./view.js";
import { contribSettingsTabs } from "./contribManifest.js";
import { ContribTabBody } from "./contribTabs.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const BLANK: ScheduledTaskInput = { title: "", prompt: "", cron: "", timezone: "UTC", enabled: true };

/** The create / edit form; `initial` seeds edit mode. */
function TaskForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  targetLocked = false,
}: {
  initial: ScheduledTaskInput;
  submitLabel: string;
  /** Edit mode: the target conversation is fixed at creation. */
  targetLocked?: boolean;
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
      await onSubmit({
        ...form,
        title: form.title.trim(),
        prompt: form.prompt.trim(),
        cron: form.cron.trim(),
        conversation_id: form.conversation_id?.trim() || null,
      });
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
          className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
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
          className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        />
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex flex-1 flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">Schedule (cron)</label>
          <input
            data-testid="task-cron"
            value={form.cron}
            onChange={(e) => set("cron", e.target.value)}
            placeholder="0 9 * * 1-5"
            className="rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm"
          />
          <span className="text-[11px] text-muted-foreground">5 fields: min hour dom mon dow — e.g. “0 9 * * 1-5” = 9am on weekdays.</span>
        </div>
        <div className="flex flex-col gap-1 sm:w-48">
          <label className="text-xs font-medium text-muted-foreground">Timezone</label>
          <input
            data-testid="task-timezone"
            value={form.timezone ?? "UTC"}
            onChange={(e) => set("timezone", e.target.value)}
            placeholder="UTC"
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">Conversation (optional)</label>
        <input
          data-testid="task-conversation"
          value={form.conversation_id ?? ""}
          onChange={(e) => set("conversation_id", e.target.value)}
          readOnly={targetLocked}
          placeholder={targetLocked ? "A new conversation each run" : "Leave empty to start a new conversation each run"}
          className="rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm read-only:opacity-60"
        />
        <span className="text-[11px] text-muted-foreground">
          {targetLocked
            ? "Fixed when the task was created; delete and recreate the task to change it."
            : "The id of one of your conversations to send the prompt to each run instead."}
        </span>
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
        <Button
          variant="default"
          size="sm"
          data-testid="task-submit"
          disabled={!valid || busy}
          onClick={submit}
        >
          {busy ? "Saving…" : submitLabel}
        </Button>
        <Button
          variant="outline"
          size="sm"
          data-testid="task-cancel"
          onClick={onCancel}
        >
          Cancel
        </Button>
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
          initial={{
            title: task.title,
            prompt: task.prompt,
            cron: task.cron,
            timezone: task.timezone,
            enabled: task.enabled,
            conversation_id: task.conversation_id ?? null,
          }}
          submitLabel="Save changes"
          targetLocked
          onCancel={() => setEditing(false)}
          onSubmit={async ({ conversation_id: _fixed, ...input }) => {
            await updateScheduledTask(agentHostConfig, task.id, input);
            setEditing(false);
            onChanged();
          }}
        />
      </li>
    );
  }

  return (
    <li data-testid="task-item" data-enabled={task.enabled} className="flex list-none flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-start sm:gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span data-testid="task-item-title" className="truncate font-medium">{task.title}</span>
          <span
            className={
              "rounded px-1.5 py-0.5 text-[10px] " +
              (task.enabled ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")
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
          {task.conversation_id && (
            <span data-testid="task-target">
              into <span className="font-mono">{task.conversation_id}</span>
            </span>
          )}
        </div>
        <p className="mt-1 line-clamp-2 text-sm text-foreground/80">{task.prompt}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="outline"
          size="xs"
          data-testid="task-toggle"
          disabled={busy}
          onClick={toggle}
          title={task.enabled ? "Disable" : "Enable"}
        >
          {task.enabled ? "Disable" : "Enable"}
        </Button>
        <Button
          variant="outline"
          size="xs"
          data-testid="task-edit"
          disabled={busy}
          onClick={() => setEditing(true)}
        >
          Edit
        </Button>
        <Button
          variant="outline"
          size="xs"
          data-testid="task-delete"
          disabled={busy}
          onClick={remove}
          aria-label={`Delete ${task.title}`}
          className="text-destructive hover:bg-destructive/10"
        >
          Delete
        </Button>
      </div>
    </li>
  );
}

const BLANK_SKILL: UserSkillInput = { name: "", description: "", body: "", enabled: true };

/** The create / edit form for a personal skill; `initial` seeds edit mode. */
function SkillForm({
  initial,
  submitLabel,
  builtinNames,
  onSubmit,
  onCancel,
}: {
  initial: UserSkillInput;
  submitLabel: string;
  builtinNames: string[];
  onSubmit: (input: UserSkillInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<UserSkillInput>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof UserSkillInput>(k: K, v: UserSkillInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ ...form, name: form.name.trim(), description: form.description.trim() });
    } catch (e) {
      // The server's validation message, which is written for this form.
      setError((e as Error)?.message ?? "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const name = form.name.trim();
  const valid = name && form.description.trim() && form.body.trim();
  // A same-named personal skill replaces the deployment's, which is allowed but worth saying.
  const shadows = builtinNames.includes(name);

  return (
    <div data-testid="skill-form" className="flex flex-col gap-3 rounded-md border bg-muted/30 p-4">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">Name</label>
        <input
          data-testid="skill-name"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="acme-conventions"
          className="rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm"
        />
        <span className="text-[11px] text-muted-foreground">
          Lowercase letters, digits and dashes — it is the filename the agent sees.
        </span>
        {shadows && (
          <span data-testid="skill-shadow-warning" className="text-[11px] text-warning">
            A built-in skill is also called “{name}”. Yours will replace it in your conversations.
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">When to use it</label>
        <textarea
          data-testid="skill-description"
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="Conventions for the acme/app repo. Use when working in acme/app or reviewing its PRs."
          rows={2}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        />
        <span className="text-[11px] text-muted-foreground">
          This is what the agent reads to decide the skill applies, so describe the situation, not the contents.
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">Instructions (markdown)</label>
        <textarea
          data-testid="skill-body"
          value={form.body}
          onChange={(e) => set("body", e.target.value)}
          placeholder={"# Acme conventions\n\n- Run `make check` before pushing.\n- Never edit generated/."}
          rows={10}
          className="rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          data-testid="skill-enabled"
          type="checkbox"
          checked={form.enabled ?? true}
          onChange={(e) => set("enabled", e.target.checked)}
        />
        Enabled
      </label>
      {error && <p data-testid="skill-form-error" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button variant="default" size="sm" data-testid="skill-submit" disabled={!valid || busy} onClick={submit}>
          {busy ? "Saving…" : submitLabel}
        </Button>
        <Button variant="outline" size="sm" data-testid="skill-cancel" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** One skill row — summary + enable toggle, edit, delete. */
function SkillRow({
  skill,
  builtinNames,
  onChanged,
}: {
  skill: UserSkillView;
  builtinNames: string[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    setBusy(true);
    try {
      await updateUserSkill(agentHostConfig, skill.id, { enabled: !skill.enabled });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete skill “${skill.name}”?`)) return;
    setBusy(true);
    try {
      await deleteUserSkill(agentHostConfig, skill.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <li data-testid="skill-item" className="list-none">
        <SkillForm
          initial={{ name: skill.name, description: skill.description, body: skill.body, enabled: skill.enabled }}
          submitLabel="Save changes"
          builtinNames={builtinNames}
          onCancel={() => setEditing(false)}
          onSubmit={async (input) => {
            await updateUserSkill(agentHostConfig, skill.id, input);
            setEditing(false);
            onChanged();
          }}
        />
      </li>
    );
  }

  return (
    <li
      data-testid="skill-item"
      data-enabled={skill.enabled}
      className="flex list-none flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-start sm:gap-3"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span data-testid="skill-item-name" className="truncate font-mono font-medium">{skill.name}</span>
          <span
            className={
              "rounded px-1.5 py-0.5 text-[10px] " +
              (skill.enabled ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")
            }
          >
            {skill.enabled ? "enabled" : "disabled"}
          </span>
          {builtinNames.includes(skill.name) && (
            <span data-testid="skill-item-shadow" className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
              replaces a built-in
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{skill.description}</p>
        <p className="mt-1 line-clamp-2 text-sm text-foreground/80">{skill.body}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="outline"
          size="xs"
          data-testid="skill-toggle"
          disabled={busy}
          onClick={toggle}
          title={skill.enabled ? "Disable" : "Enable"}
        >
          {skill.enabled ? "Disable" : "Enable"}
        </Button>
        <Button variant="outline" size="xs" data-testid="skill-edit" disabled={busy} onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button
          variant="outline"
          size="xs"
          data-testid="skill-delete"
          disabled={busy}
          onClick={remove}
          aria-label={`Delete ${skill.name}`}
          className="text-destructive hover:bg-destructive/10"
        >
          Delete
        </Button>
      </div>
    </li>
  );
}

/**
 * The caller's own skills, which the agent loads next to the deployment's built-in ones
 * at the start of their next conversation (an open conversation keeps the set it started
 * with). Reports itself unconfigured when the host has no database.
 */
function SkillsSection() {
  const [skills, setSkills] = useState<UserSkillView[]>([]);
  const [builtinNames, setBuiltinNames] = useState<string[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    const res = await loadUserSkills(agentHostConfig);
    setConfigured(res.configured);
    setSkills(res.skills);
    setBuiltinNames(res.builtinNames);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-medium">Your skills</h2>
          <p className="text-sm text-muted-foreground">
            Markdown you write once and Scooter reads when it is relevant — your repos, your
            conventions, how you like things done. Added to every new conversation of yours.
          </p>
        </div>
        {configured && !creating && (
          <Button variant="default" size="sm" data-testid="skill-new" onClick={() => setCreating(true)}>
            + New skill
          </Button>
        )}
      </div>

      {!configured ? (
        <p data-testid="skills-unavailable" className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
          This deployment has no database configured, so personal skills aren’t available here.
        </p>
      ) : (
        <>
          {creating && (
            <SkillForm
              initial={BLANK_SKILL}
              submitLabel="Create skill"
              builtinNames={builtinNames}
              onCancel={() => setCreating(false)}
              onSubmit={async (input) => {
                await createUserSkill(agentHostConfig, input);
                setCreating(false);
                await refresh();
              }}
            />
          )}

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : skills.length === 0 ? (
            <p data-testid="skills-empty" className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
              No skills yet. Create one, or ask Scooter to write one for you.
            </p>
          ) : (
            <ul data-testid="skill-list" className="flex flex-col gap-2">
              {skills.map((s) => (
                <SkillRow key={s.id} skill={s} builtinNames={builtinNames} onChanged={refresh} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** The Users section; shows a "not configured" note when no identity store is wired (501). */
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

/** Scheduled tasks: the cron-driven prompts. */
function ScheduledTasksSection() {
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
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-medium">Scheduled tasks</h2>
          <p className="text-sm text-muted-foreground">
            Run a prompt on a schedule — each run starts a fresh conversation.
          </p>
        </div>
        {configured && !creating && (
          <Button
            variant="default"
            size="sm"
            data-testid="task-new"
            onClick={() => setCreating(true)}
          >
            + New task
          </Button>
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
  );
}

/** Registered devices: the laptops (Ed25519 public keys registered once with a join
 *  token) allowed to serve this user's conversations, where deregistering revokes the
 *  key immediately. */
function DeviceList() {
  const [devices, setDevices] = useState<ByocDevice[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDevices(await loadDevices());
      setError(null);
    } catch (e) {
      // A real failure must not render as "no devices".
      setError(e instanceof Error ? e.message : "Could not load devices");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        await deregisterDevice(id);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not deregister");
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  // Nothing registered and nothing broken: stay quiet rather than show an empty table
  // where device auth is off.
  if (!devices.length && !error) return null;

  return (
    <div data-testid="byoc-device-list" className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Registered devices</h3>
      {error && <p data-testid="byoc-device-error" className="text-sm text-destructive">{error}</p>}
      {devices.map((d) => (
        <div
          key={d.id}
          data-testid="byoc-device-row"
          className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
        >
          <span>
            <span data-testid="byoc-device-label" className="font-medium">{d.label ?? "Unnamed device"}</span>
            <span className="ml-2 text-muted-foreground">last seen {formatLastSeen(d.lastSeen)}</span>
          </span>
          <Button
            variant="outline"
            size="xs"
            data-testid="byoc-device-deregister"
            disabled={busy === d.id}
            onClick={() => void remove(d.id)}
          >
            {busy === d.id ? "Removing…" : "Deregister"}
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Bring-your-own-Claude section: a copyable `docker run` one-liner with a fresh
 *  owner-bound join token plus a live status badge, hidden when BYO is not enabled. */
function ClaudeAgentSection() {
  const [enabled, setEnabled] = useState(true);
  const [connected, setConnected] = useState(false);
  const [authFailure, setAuthFailure] = useState<{ reason: string; at: string } | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  // Poll status so the badge flips to Connected once the container dials in (no refresh needed).
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = await loadRemoteAgentStatus(agentHostConfig);
      if (!alive) return;
      setEnabled(s.enabled);
      setConnected(s.connected);
      setAuthFailure(s.lastAuthFailure);
      setLoading(false);
    };
    void tick();
    const h = setInterval(() => void tick(), 3000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, []);

  const generate = useCallback(async () => {
    setError(null);
    try {
      const r = await requestRemoteAgentJoinToken(agentHostConfig);
      setCommand(r.dockerCommand);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate a command");
    }
  }, []);

  const copy = useCallback(() => {
    if (!command) return;
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [command]);

  if (loading) return null; // avoid a flash before we know if BYO is enabled

  // Not enabled on this deployment: render the operator fix rather than nothing, since
  // an empty tab looks broken.
  if (!enabled) {
    return (
      <section data-testid="claude-agent-section" className="flex flex-col gap-3">
        <div>
          <h2 className="font-medium">Bring your own Claude</h2>
          <p className="text-sm text-muted-foreground">
            Run Claude on your own machine with your subscription. Scooter routes your
            conversations to it — your token never leaves your machine.
          </p>
        </div>
        <div
          data-testid="claude-agent-disabled"
          className="flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-4"
        >
          <p className="text-sm font-medium text-destructive">
            Not enabled on this deployment.
          </p>
          <p className="text-sm text-muted-foreground">
            The agent-host is running without a bring-your-own-Claude join secret, so it serves no{" "}
            <span className="font-mono">/remote-agent</span> routes. Enable it — and the BYOC
            controller your container connects to — in your kubenix config, then redeploy:
          </p>
          <pre
            data-testid="claude-agent-enable-sample"
            className="overflow-x-auto rounded bg-muted/50 p-3 text-xs leading-relaxed"
          >{`scooter.byoc.enable = true;`}</pre>
          <p className="text-xs text-muted-foreground">
            This enables BYOC: the controller, the{" "}
            <span className="font-mono">/byoc</span> connect path on your existing ingress host,
            and this Settings page. Use{" "}
            <span className="font-mono">byoc.ingress.host</span> for a dedicated hostname.{" "}
            <span className="font-mono">deploy.sh</span> generates the signing secret
            (<span className="font-mono">agent-remote-join-secret</span>) if missing. See{" "}
            <span className="font-mono">docs/BYO_CLAUDE_REMOTE_AGENT.md</span>.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section data-testid="claude-agent-section" className="flex flex-col gap-3">
      <div>
        <h2 className="font-medium">Your Claude agent</h2>
        <p className="text-sm text-muted-foreground">
          Run Claude on your own machine with your subscription. Scooter routes your conversations
          to it; scheduled tasks still use the shared cloud model.
        </p>
      </div>

      <div className="flex items-center gap-2 text-sm" data-testid="claude-agent-status">
        <span
          aria-hidden
          className={`inline-block h-2.5 w-2.5 rounded-full ${connected ? "bg-success" : "bg-muted-foreground/40"}`}
        />
        {connected ? (
          <span data-testid="claude-agent-connected" className="font-medium text-success">Connected</span>
        ) : (
          <span data-testid="claude-agent-disconnected" className="text-muted-foreground">Not connected</span>
        )}
      </div>

      {/* A rejected connection is a different state than "no container", so say why. */}
      {!connected && authFailure ? (
        <p data-testid="claude-agent-auth-failure" className="text-sm text-destructive">
          A container failed to authenticate at {new Date(authFailure.at).toLocaleString()}:{" "}
          <span className="font-mono">{authFailure.reason}</span>. Generate a fresh command below and
          restart it.
        </p>
      ) : null}

      {!command ? (
        <Button
          variant="outline"
          size="sm"
          data-testid="claude-agent-generate"
          onClick={() => void generate()}
          className="self-start"
        >
          Connect your Claude agent
        </Button>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            Run this on your machine (needs Docker). On first run, open{" "}
            <span className="font-mono">http://localhost:1717/login</span> to sign in to Claude.
          </p>
          <pre
            data-testid="claude-agent-command"
            className="overflow-x-auto rounded-md border bg-muted/30 p-3 text-xs font-mono whitespace-pre"
          >
            {command}
          </pre>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid="claude-agent-copy"
              onClick={copy}
            >
              {copied ? <><Check className="size-3.5" aria-hidden /> Copied</> : "Copy command"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void generate()}
              className="text-muted-foreground"
            >
              Regenerate
            </Button>
          </div>
        </div>
      )}
      {error && <p data-testid="claude-agent-error" className="text-sm text-destructive">{error}</p>}
      <DeviceList />
    </section>
  );
}

/** Admin Area — deployment-wide administration. Holds the user directory today. */
/** Deployment hooks; changes apply to conversations started afterwards. */
function HooksSection() {
  const [hooks, setHooks] = useState<UserHookView[]>([]);
  const [configurable, setConfigurable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await loadUserHooks(agentHostConfig);
    setConfigurable(res.configurable);
    setHooks(res.hooks);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (h: UserHookView) => {
    setBusy(h.id);
    setError(null);
    try {
      await setUserHookEnabled(agentHostConfig, h.id, !h.enabled);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="font-medium">Hooks</h2>
        <p className="text-sm text-muted-foreground">
          Checks your deployment runs in the sandbox while Scooter works, such as making sure it
          pushes its work before stopping. Changes apply to conversations you start afterwards.
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : hooks.length === 0 ? (
        <p data-testid="hooks-empty" className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
          This deployment has no hooks.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {hooks.map((h) => (
            <li
              key={h.id}
              data-testid="hook-item"
              data-enabled={h.enabled}
              className="flex list-none flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-start sm:gap-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono font-medium">{h.id}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{h.event}</span>
                  <span
                    className={
                      "rounded px-1.5 py-0.5 text-[10px] " +
                      (h.enabled ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")
                    }
                  >
                    {h.enabled ? "on" : "off"}
                  </span>
                </div>
                {h.description && <p className="mt-1 text-sm text-foreground/80">{h.description}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {h.userCanDisable && configurable ? (
                  <Button
                    variant="outline"
                    size="xs"
                    data-testid="hook-toggle"
                    disabled={busy === h.id}
                    onClick={() => void toggle(h)}
                  >
                    {h.enabled ? "Turn off" : "Turn on"}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">{h.userCanDisable ? "Needs a database" : "Required"}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AdminAreaSection() {
  return (
    <div data-testid="admin-area" className="flex flex-col gap-6">
      <UsersSection />
    </div>
  );
}

const TAB_BODIES: Record<BuiltinTab, FC> = {
  tasks: ScheduledTasksSection,
  skills: SkillsSection,
  hooks: HooksSection,
  claude: ClaudeAgentSection,
  admin: AdminAreaSection,
};

/**
 * The settings page: a collapsible tab menu plus the selected tab's body.
 *
 * Each tab is a real URL (/settings/<tab>) owned by view.ts, so it is bookmarkable,
 * survives a refresh, and Back/Forward moves between tabs. The tabs are an accordion
 * collapsed by default at every width, and selecting a tab does not auto-close it.
 */
export function SettingsPage() {
  // The manifest is loaded before first paint (main.tsx), so contrib tabs are known here
  // and a deep link to one survives a refresh. An id that is neither built-in nor in the
  // manifest lands on the default tab.
  const contribTabs = contribSettingsTabs();
  const tabs = useMemo(() => settingsTabList(contribTabs), [contribTabs]);
  const tab = resolveTab(useSettingsTab(), tabs);
  // A built-in always wins, matching settingsTabList.
  const contribTab = isBuiltinTab(tab) ? undefined : contribTabs[tab];
  const Body = isBuiltinTab(tab) ? TAB_BODIES[tab] : undefined;
  const [menuOpen, setMenuOpen] = useState(false);
  const activeLabel = tabs.find((t) => t.id === tab)?.label ?? "Settings";

  const tabButtons = tabs.map((t) => {
    const active = t.id === tab;
    return (
      <Button
        key={t.id}
        variant="ghost"
        size="sm"
        role="tab"
        aria-selected={active}
        data-testid={`settings-tab-${t.id}`}
        onClick={() => viewStore.setTab(t.id)}
        className={cn("justify-start", active ? "bg-accent font-medium" : "text-muted-foreground")}
      >
        {t.label}
      </Button>
    );
  });

  return (
    <div data-testid="settings-page" className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 overflow-hidden p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          data-testid="settings-back"
          onClick={() => viewStore.set("chat")}
        >
          <ArrowLeft className="size-4" aria-hidden /> Back
        </Button>
        <h1 className="text-lg font-semibold">Settings</h1>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row sm:gap-6">
        {/* Accordion tab menu, collapsed below the desk (1200px) breakpoint; at desk and
            above the list is always shown and the trigger hidden. */}
        <div data-testid="settings-tabs" className="shrink-0 sm:w-56">
          <Button
            variant="outline"
            size="sm"
            data-testid="settings-tabs-toggle"
            data-open={menuOpen}
            aria-expanded={menuOpen}
            aria-controls="settings-tab-menu"
            onClick={() => setMenuOpen((o) => !o)}
            className="w-full justify-between desk:hidden"
          >
            <span className="font-medium">{activeLabel}</span>
            <ChevronRight aria-hidden className={"size-4 transition-transform " + (menuOpen ? "rotate-90" : "")} />
          </Button>
          {/* Always in the DOM so the desk: variant can force it open with pure CSS. */}
          <nav
            id="settings-tab-menu"
            role="tablist"
            aria-orientation="vertical"
            className={cn(
              "mt-1 flex-col gap-1 rounded-md border bg-background/60 p-1",
              menuOpen ? "flex" : "hidden",
              "desk:mt-0 desk:flex desk:border-0 desk:bg-transparent desk:p-0",
            )}
          >
            {tabButtons}
          </nav>
        </div>

        <div
          role="tabpanel"
          data-testid={`settings-panel-${tab}`}
          className="min-h-0 flex-1 overflow-y-auto pr-1"
        >
          {contribTab ? <ContribTabBody key={tab} tab={contribTab} /> : Body && <Body />}
        </div>
      </div>
    </div>
  );
}
