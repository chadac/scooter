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

import { useCallback, useEffect, useState, type FC } from "react";

import { agentHostConfig } from "./config.js";
import { loadDevices, deregisterDevice, formatLastSeen, type ByocDevice } from "./byocDevices.js";
import {
  loadScheduledTasks,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  loadUsers,
  searchModules,
  loadRemoteAgentStatus,
  requestRemoteAgentJoinToken,
  type ScheduledTaskView,
  type ScheduledTaskInput,
  type UserView,
  type RegistryModule,
} from "./client.js";
import { useSessions, currentConversation } from "./sessions.js";
import { viewStore, useSettingsTab, SETTINGS_TABS, type SettingsTab } from "./view.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
      // Modules live in the conversation's sandbox, so there is nothing to list until the
      // conversation exists server-side. Unavailable, not a 404 against a synthetic id.
      const res = await currentConversation()?.ifCreated(
        (id) => searchModules(agentHostConfig, id, ""),
        null as Awaited<ReturnType<typeof searchModules>> | null,
      );
      if (!res) { setAvailable(false); setLoading(false); return; }
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

/** Scheduled tasks — the cron-driven prompts. Extracted from the old single-page
 *  Settings so it can live behind its own tab. Behaviour is unchanged. */
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

/** Bring Your Own Claude — the user runs a container holding THEIR Claude
 *  subscription and scooter routes the brain to it. The settings UI for this ships
 *  with the BYO feature itself (PR #275, still in review); this tab is the shell it
 *  drops into, so the section can be added without restructuring the page again. */
/** Connect-your-Claude-agent section (bring-your-own-Claude). Shows a copyable `docker run`
 *  one-liner (with a freshly-minted owner-bound join token) + a LIVE status badge that flips to
 *  "Connected" when the user's container registers. Hidden when BYO isn't enabled (routes 404). */
/** Registered devices (§P) — the laptops allowed to serve this user's conversations.
 *
 *  A device is an Ed25519 PUBLIC key the container registered once with a join token; it then
 *  authenticates by signing a server nonce, so it reconnects indefinitely without a fresh token.
 *  Deregistering is a COMPLETE revocation: the key stops working immediately and that laptop
 *  cannot re-register without a new (authenticated) join token. */
function DeviceList() {
  const [devices, setDevices] = useState<ByocDevice[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDevices(await loadDevices());
      setError(null);
    } catch (e) {
      // A real failure must not render as "no devices" — that would look like a silent
      // deregistration of every laptop the user owns.
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

  // Nothing registered and nothing broken: stay quiet rather than showing an empty table on a
  // deployment where device auth is not enabled at all.
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

  // NOT ENABLED on this deployment. Render an EXPLANATION, never nothing: an empty tab looks like
  // a broken page, and the reader has no way to tell "off by config" from "the UI failed to load".
  // The fix is an operator action, so show exactly what to change rather than a bare apology.
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
          >{`agentSandbox.byoc.enable = true;`}</pre>
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

      {/* A rejected connection is a different state than "no container": say WHY, loudly.
          Previously a container with a bad/expired token fast-looped in silence while this
          page showed a clean "Not connected" — invisible on both ends. */}
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
              {copied ? "Copied ✓" : "Copy command"}
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
function AdminAreaSection() {
  return (
    <div data-testid="admin-area" className="flex flex-col gap-6">
      <UsersSection />
    </div>
  );
}

const TAB_BODIES: Record<SettingsTab, FC> = {
  tasks: ScheduledTasksSection,
  claude: ClaudeAgentSection,
  modules: ModulesSettingsSection,
  admin: AdminAreaSection,
};

/**
 * The settings page: a left tab rail + the selected tab's body.
 *
 * Each tab is a real URL (/settings/<tab>) owned by view.ts, so a tab is
 * bookmarkable, survives a refresh, and Back/Forward moves between tabs — rather
 * than the previous single scrolling page reached only by a header toggle.
 */
export function SettingsPage() {
  const tab = useSettingsTab();
  const Body = TAB_BODIES[tab];

  return (
    <div data-testid="settings-page" className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 overflow-hidden p-6">
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          data-testid="settings-back"
          onClick={() => viewStore.set("chat")}
        >
          ← Back
        </Button>
        <h1 className="text-lg font-semibold">Settings</h1>
      </div>

      <div className="flex min-h-0 flex-1 gap-6">
        {/* Left tab rail. role=tablist + aria-selected so the active tab is exposed to
            assistive tech and assertable in tests. */}
        <nav data-testid="settings-tabs" role="tablist" aria-orientation="vertical" className="flex w-56 shrink-0 flex-col gap-1">
          {SETTINGS_TABS.map((t) => {
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
                className={cn(
                  "justify-start",
                  active ? "bg-accent font-medium" : "text-muted-foreground"
                )}
              >
                {t.label}
              </Button>
            );
          })}
        </nav>

        <div
          role="tabpanel"
          data-testid={`settings-panel-${tab}`}
          className="min-h-0 flex-1 overflow-y-auto pr-1"
        >
          <Body />
        </div>
      </div>
    </div>
  );
}
