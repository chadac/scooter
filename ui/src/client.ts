/**
 * UI client — the reusable "general library" wrapping assistant-ui's native
 * AG-UI runtime, pointed at the agent-host (NOT at an LLM provider).
 *
 * The agent-host exposes the standard AG-UI HttpAgent protocol at POST /agui:
 * a RunAgentInput in, an SSE stream of AG-UI events out. So we just construct
 * an @ag-ui/client HttpAgent against it; assistant-ui's useAgUiRuntime renders
 * the events (messages, tool calls, reasoning) with no custom transport code.
 */

import { HttpAgent } from "@ag-ui/client";

export interface AgentHostConfig {
  /** Base URL of the agent-host (e.g. http://localhost:8080). */
  baseUrl: string;
  /** Auth token for the agent-host, if any. */
  token?: string;
}

/** Build an AG-UI agent bound to the agent-host's /agui endpoint. */
export function createAgentHostAgent(config: AgentHostConfig): HttpAgent {
  return new HttpAgent({
    url: `${config.baseUrl.replace(/\/$/, "")}/agui`,
    headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined,
  });
}

/** A conversation as the management API returns it (GET /conversations). */
export interface ConversationView {
  id: string;
  threadId: string;
  title: string;
  /** Sandbox lifecycle state. */
  status: "running" | "suspended" | "ended";
  createdAt: number;
  lastActivityAt: number;
  /** The conversation's model (undefined = host default). */
  model?: string;
  /** Distinct providers this conversation links to ("github"|"slack"|…), for a
   *  per-row icon in the sidebar. [] when it has no linked resources. */
  sources?: string[];
  /** Compact summary of the conversation's linked resources (source/type/title/url),
   *  so the sidebar can show the linked PR/MR/thread NAME instead of the title, search
   *  by it, and filter by provider — without a per-row /links fetch. [] when none. */
  links?: ConversationLink[];
}

/** The model catalog (GET /models): the default + the offered models. */
export interface ModelCatalog {
  default: string | null;
  available: string[];
  /** Model id -> the provider tags that offer it ("byoc"|"goose"|"claude-code"|…).
   *  [] / absent = offered on every provider (legacy, hint-less catalogs). Lets the
   *  picker group each model under its source provider. */
  providers?: Record<string, string[]>;
}

/** Fetch the offered models. Returns an empty catalog if the server is
 *  unreachable or has none configured (the picker then hides itself). */
export async function loadModels(config: AgentHostConfig): Promise<ModelCatalog> {
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/models`, {
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined,
    });
    if (!res.ok) return { default: null, available: [] };
    return (await res.json()) as ModelCatalog;
  } catch {
    return { default: null, available: [] };
  }
}

/** An external resource a conversation is linked to (GET /conversations/:id/links). */
export interface ConversationLink {
  source: string;       // "github" | "gitlab" | "slack" | "jira" | …
  resourceType: string; // "pull_request" | "issue" | "thread" | …
  url?: string;
  title?: string;
}

/** Load a conversation's external resource links (the PR/issue/thread it came
 *  from) for the linked-resources panel. */
export async function loadLinks(
  config: AgentHostConfig,
  conversationId: string,
): Promise<ConversationLink[]> {
  try {
    const res = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/links`,
      { headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined },
    );
    if (!res.ok) {
      // Finding #24: a non-OK response is a real failure, not "no links" — log it
      // so an empty links panel that's actually an error is diagnosable (the UI
      // still degrades to [] rather than breaking).
      console.warn(`[client] loadLinks ${conversationId}: HTTP ${res.status}`);
      return [];
    }
    return ((await res.json()) as { links?: ConversationLink[] }).links ?? [];
  } catch (e) {
    console.warn(`[client] loadLinks ${conversationId} failed:`, e);
    return [];
  }
}

/** A web service running in the conversation's sandbox, reverse-proxied at
 *  /c/<id>/<name>/ (GET /conversations/:id/web-services). */
export interface WebService {
  name: string;
  displayName: string;
  /** Path to open the service in the browser (under the full threadId). */
  url: string;
  running: boolean;
}

/** List the conversation's declared web services (marimo/xterm/…) with liveness.
 *  Empty when none declared or the server/pod is unreachable. */
export async function loadWebServices(
  config: AgentHostConfig,
  conversationId: string,
  opts: { refresh?: boolean } = {},
): Promise<WebService[]> {
  try {
    const res = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/web-services` +
        (opts.refresh ? "?refresh=1" : ""),
      { headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined },
    );
    if (!res.ok) {
      console.warn(`[client] loadWebServices ${conversationId}: HTTP ${res.status}`);
      return [];
    }
    return ((await res.json()) as { services?: WebService[] }).services ?? [];
  } catch (e) {
    console.warn(`[client] loadWebServices ${conversationId} failed:`, e);
    return [];
  }
}

/** A Nix module from the broker registry (search result / settings list). */
export interface RegistryModule {
  id: number;
  name: string;
  description: string;
  visibility: "public" | "private";
  owner?: string;
  /** True if it's already attached to this conversation. */
  attached?: boolean;
}

/** Result of a module-registry fetch — `configured` distinguishes "no module
 *  registry (fake/local, or pod asleep)" from "configured but nothing found". */
export interface ModuleSearchResult {
  configured: boolean;
  modules: RegistryModule[];
}

/** Search the broker module catalog (caller's own + all public) for a conversation.
 *  Empty query = all. 501 → { configured:false }. Needs a running pod. */
export async function searchModules(
  config: AgentHostConfig,
  conversationId: string,
  query = "",
): Promise<ModuleSearchResult> {
  try {
    const res = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/module-registry?q=${encodeURIComponent(query)}`,
      { headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined },
    );
    if (res.status === 501) return { configured: false, modules: [] };
    if (!res.ok) {
      console.warn(`[client] searchModules ${conversationId}: HTTP ${res.status}`);
      return { configured: true, modules: [] };
    }
    return { configured: true, modules: ((await res.json()) as { modules?: RegistryModule[] }).modules ?? [] };
  } catch (e) {
    console.warn(`[client] searchModules ${conversationId} failed:`, e);
    return { configured: true, modules: [] };
  }
}

/** Manually compact a conversation (summarize older turns → continue on
 *  summary + recent). Resolves { compacted } — false when too short to compact.
 *  Throws with the server's message on failure (leaves the conversation unchanged). */
export async function compactConversation(
  config: AgentHostConfig,
  conversationId: string,
): Promise<{ compacted: boolean; summarizedTurns?: number; keptRuns?: number }> {
  const res = await fetch(
    `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/compact`,
    { method: "POST", headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `compaction failed (HTTP ${res.status})`);
  }
  return (await res.json()) as { compacted: boolean; summarizedTurns?: number; keptRuns?: number };
}

/** Install (attach) a registry module by name-or-id + re-converge. Throws with the
 *  server's error message on failure (unknown module, pod asleep, switch error). */
export async function installModule(
  config: AgentHostConfig,
  conversationId: string,
  ref: string,
): Promise<string> {
  const res = await fetch(
    `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/modules/${encodeURIComponent(ref)}/install`,
    { method: "POST", headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `install failed (HTTP ${res.status})`);
  }
  return ((await res.json()) as { message?: string }).message ?? `attached ${ref}`;
}

/** Start a web service (systemctl start via the agent-host). Resolves true once
 *  the start is issued (not once healthy — the caller polls/opens after). */
export async function startWebService(
  config: AgentHostConfig,
  conversationId: string,
  name: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/web-services/${encodeURIComponent(name)}/start`,
      { method: "POST", headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined },
    );
    if (!res.ok) console.warn(`[client] startWebService ${conversationId}/${name}: HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    console.warn(`[client] startWebService ${conversationId}/${name} failed:`, e);
    return false;
  }
}

/** Stop a web service (systemctl stop via the agent-host). Resolves true once the
 *  stop is issued. */
export async function stopWebService(
  config: AgentHostConfig,
  conversationId: string,
  name: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/web-services/${encodeURIComponent(name)}/stop`,
      { method: "POST", headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined },
    );
    if (!res.ok) console.warn(`[client] stopWebService ${conversationId}/${name}: HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    console.warn(`[client] stopWebService ${conversationId}/${name} failed:`, e);
    return false;
  }
}

/** Resume (start) a suspended sandbox pod — POST /conversations/:id/resume, which
 *  revives the pod (mounts the PVCs). Returns the conversation's new status, or null
 *  on failure. Lets the user bring the pod up to reach services without prompting. */
/** Create a conversation (POST /conversations) and return the id the SERVER assigned.
 *  The server owns conversation ids: a client-chosen id would become an event-log key and
 *  a k8s resource name. Returns null on failure so the caller can surface it rather than
 *  prompting an id that does not exist. */
export async function createConversation(
  config: AgentHostConfig,
  title?: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/conversations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify(title ? { title } : {}),
    });
    if (!res.ok) {
      console.warn(`[client] createConversation: HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { id?: string };
    return body.id ?? null;
  } catch (e) {
    console.warn("[client] createConversation failed:", e);
    return null;
  }
}

export async function resumeConversation(
  config: AgentHostConfig,
  conversationId: string,
): Promise<{ status: string } | null> {
  try {
    const res = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/resume`,
      { method: "POST", headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined },
    );
    if (!res.ok) {
      console.warn(`[client] resumeConversation ${conversationId}: HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as { status: string };
  } catch (e) {
    console.warn(`[client] resumeConversation ${conversationId} failed:`, e);
    return null;
  }
}

/** Rename a conversation (PATCH /conversations/:id/title). Sets a USER title that the
 *  agent's <title> can no longer override. Returns the updated view, or null on error. */
export async function renameConversation(
  config: AgentHostConfig,
  conversationId: string,
  title: string,
): Promise<ConversationView | null> {
  try {
    const res = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/title`,
      { method: "PATCH", headers: { ...authHeaders(config), "content-type": "application/json" }, body: JSON.stringify({ title }) },
    );
    if (!res.ok) {
      console.warn(`[client] renameConversation ${conversationId}: HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as ConversationView;
  } catch (e) {
    console.warn(`[client] renameConversation ${conversationId} failed:`, e);
    return null;
  }
}

/** Star / unstar a conversation (PATCH /conversations/:id/starred). Returns the
 *  updated view, or null on error. */
export async function setConversationStarred(
  config: AgentHostConfig,
  conversationId: string,
  starred: boolean,
): Promise<ConversationView | null> {
  try {
    const res = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/starred`,
      { method: "PATCH", headers: { ...authHeaders(config), "content-type": "application/json" }, body: JSON.stringify({ starred }) },
    );
    if (!res.ok) {
      console.warn(`[client] setConversationStarred ${conversationId}: HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as ConversationView;
  } catch (e) {
    console.warn(`[client] setConversationStarred ${conversationId} failed:`, e);
    return null;
  }
}

/** End + delete a conversation (DELETE /conversations/:id) — destroys the sandbox +
 *  PVCs and purges the record. Returns true on success (204/404 both mean "gone"). */
export async function deleteConversation(
  config: AgentHostConfig,
  conversationId: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}`,
      { method: "DELETE", headers: authHeaders(config) },
    );
    return res.ok || res.status === 404;
  } catch (e) {
    console.warn(`[client] deleteConversation ${conversationId} failed:`, e);
    return false;
  }
}

/** Fetch the current status of one conversation (GET /conversations/:id) — a light
 *  poll used to track a resume through to "running". */
export async function loadConversationStatus(
  config: AgentHostConfig,
  conversationId: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}`,
      { headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined },
    );
    if (!res.ok) return null;
    return ((await res.json()) as { status?: string }).status ?? null;
  } catch {
    return null;
  }
}

/** Fetch the conversation's status AND actual pod readiness (GET /:id/ready). The
 *  status can be "running" while the pod is still ContainerCreating; `ready` is true
 *  only once the pod is actually up (exec succeeds) — so the UI can show "Starting…"
 *  in between instead of a premature "Running". */
export async function loadSandboxReady(
  config: AgentHostConfig,
  conversationId: string,
): Promise<{ status: string; ready: boolean }> {
  try {
    const res = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/ready`,
      { headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined },
    );
    if (!res.ok) return { status: "unknown", ready: false };
    return (await res.json()) as { status: string; ready: boolean };
  } catch {
    return { status: "unknown", ready: false };
  }
}

/** A resource quantity side (requests or limits): cpu/memory as k8s quantity
 *  strings ("500m", "1Gi"), gpu as a count. Any field may be absent. */
export interface ResourceQuantity {
  cpu?: string;
  memory?: string;
  gpu?: number;
}

/** The sandbox's resource allotment (GET /:id/resources). null = not available
 *  (no broker / fake mode) — the UI then omits the resources row. */
export interface SandboxResources {
  requests?: ResourceQuantity;
  limits?: ResourceQuantity;
}

/** Fetch the conversation's sandbox resource allotment (cpu/memory/gpu requests +
 *  limits), so the Sandbox tab can show the user what the pod is sized for. Returns
 *  null on any error / when the deployment doesn't expose it. */
export async function loadSandboxResources(
  config: AgentHostConfig,
  conversationId: string,
): Promise<SandboxResources | null> {
  try {
    const res = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/resources`,
      { headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { resources: SandboxResources | null };
    return body.resources ?? null;
  } catch {
    return null;
  }
}

/**
 * Load ALL conversations from the agent-host so the sidebar survives a page
 * refresh and every conversation is listed/searchable (not just the ones this
 * browser tab created in memory).
 */
/** The caller's identity (GET /whoami) — from the trusted ingress header. */
export interface Whoami {
  id: string;
  email: string | null;
  anonymous: boolean;
}

/** Fetch the caller's identity. Falls back to anonymous if unreachable. */
export async function loadWhoami(config: AgentHostConfig): Promise<Whoami> {
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/whoami`, {
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined,
    });
    if (!res.ok) return { id: "anonymous", email: null, anonymous: true };
    return (await res.json()) as Whoami;
  } catch {
    return { id: "anonymous", email: null, anonymous: true };
  }
}

/** A scheduled task, as the agent-host's /scheduled-tasks proxy returns it. */
export interface ScheduledTaskView {
  id: string;
  title: string;
  prompt: string;
  cron: string;
  timezone: string;
  owner: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
}

/** One run record for a scheduled task. */
export interface ScheduledTaskRun {
  id: string;
  task_id: string;
  conversation_id: string | null;
  status: string;
  error: string | null;
  fired_at: string;
}

/** Fields the settings form sends when creating/editing a scheduled task. */
export interface ScheduledTaskInput {
  title: string;
  prompt: string;
  cron: string;
  timezone?: string;
  enabled?: boolean;
}

/** Result of a scheduled-tasks fetch — `configured` distinguishes "the scheduler
 *  isn't deployed" (501) from "you have no tasks" (200, []), so the settings page
 *  can show the right empty state. */
export interface ScheduledTasksResult {
  configured: boolean;
  tasks: ScheduledTaskView[];
}

const authHeaders = (config: AgentHostConfig): Record<string, string> =>
  config.token ? { Authorization: `Bearer ${config.token}` } : {};

/** List the caller's scheduled tasks. 501 → { configured:false } (scheduler off). */
export async function loadScheduledTasks(config: AgentHostConfig): Promise<ScheduledTasksResult> {
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/scheduled-tasks`, {
      headers: authHeaders(config),
    });
    if (res.status === 501) return { configured: false, tasks: [] };
    if (!res.ok) {
      console.warn(`[client] loadScheduledTasks: HTTP ${res.status}`);
      return { configured: true, tasks: [] };
    }
    return { configured: true, tasks: ((await res.json()) as { tasks?: ScheduledTaskView[] }).tasks ?? [] };
  } catch (e) {
    console.warn("[client] loadScheduledTasks failed:", e);
    return { configured: true, tasks: [] };
  }
}

/** A learned Scooter user, as the agent-host's /users route returns it. */
export interface UserView {
  id: string;
  email?: string;
  name?: string;
  updatedAt?: string;
}

/** Result of a /users fetch — `configured` distinguishes "no identity store" (501)
 *  from "configured but nobody seen yet" (200, []), so the page shows the right
 *  empty state (mirrors ScheduledTasksResult). */
export interface UsersResult {
  configured: boolean;
  users: UserView[];
}

/** List the learned Scooter users. 501 → { configured:false } (no identity store). */
export async function loadUsers(config: AgentHostConfig): Promise<UsersResult> {
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/users`, {
      headers: authHeaders(config),
    });
    if (res.status === 501) return { configured: false, users: [] };
    if (!res.ok) {
      console.warn(`[client] loadUsers: HTTP ${res.status}`);
      return { configured: true, users: [] };
    }
    return { configured: true, users: ((await res.json()) as { users?: UserView[] }).users ?? [] };
  } catch (e) {
    console.warn("[client] loadUsers failed:", e);
    return { configured: true, users: [] };
  }
}

/** Fetch one scheduled task with its recent run history. Null if not found. */
export async function loadScheduledTask(
  config: AgentHostConfig,
  id: string,
): Promise<{ task: ScheduledTaskView; runs: ScheduledTaskRun[] } | null> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/scheduled-tasks/${encodeURIComponent(id)}`, {
    headers: authHeaders(config),
  });
  if (!res.ok) return null;
  return (await res.json()) as { task: ScheduledTaskView; runs: ScheduledTaskRun[] };
}

/** Create a scheduled task. Throws with the server's error message on failure. */
export async function createScheduledTask(
  config: AgentHostConfig,
  input: ScheduledTaskInput,
): Promise<ScheduledTaskView> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/scheduled-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(config) },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  return (await res.json()) as ScheduledTaskView;
}

/** Patch a scheduled task (any subset of fields). Throws on failure. */
export async function updateScheduledTask(
  config: AgentHostConfig,
  id: string,
  patch: Partial<ScheduledTaskInput>,
): Promise<ScheduledTaskView> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/scheduled-tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders(config) },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  return (await res.json()) as ScheduledTaskView;
}

/** Delete a scheduled task. Resolves true on success (204), false if not found. */
export async function deleteScheduledTask(config: AgentHostConfig, id: string): Promise<boolean> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/scheduled-tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(config),
  });
  return res.ok;
}

/** Which conversations to list: the caller's own ("mine", default) or all. */
export type ConversationScope = "mine" | "all";

export async function loadConversations(
  config: AgentHostConfig,
  scope: ConversationScope = "mine",
): Promise<ConversationView[]> {
  return (await loadConversationsResult(config, scope)).conversations;
}

/**
 * Like loadConversations, but reports whether the server was REACHABLE — so a
 * caller can distinguish "the agent-host is down/restarting" (ok=false) from
 * "the server is up and genuinely has no conversations" (ok=true, []). The
 * initial-load retry uses this to keep retrying only while the server is down.
 */
export async function loadConversationsResult(
  config: AgentHostConfig,
  scope: ConversationScope = "mine",
): Promise<{ ok: boolean; conversations: ConversationView[] }> {
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/conversations?scope=${scope}`, {
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined,
    });
    if (!res.ok) return { ok: false, conversations: [] };
    return { ok: true, conversations: (await res.json()) as ConversationView[] };
  } catch {
    return { ok: false, conversations: [] };
  }
}

/** An image attached to a replayed message (from a MESSAGE_IMAGES event). The UI
 *  renders each via its `url` (GET /conversations/:id/assets/:assetId). */
export interface MessageImage {
  assetId: string;
  mimeType: string;
  url: string;
}

/** A minimal AG-UI message (what HttpAgent.initialMessages expects). */
export interface AguiMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** Attached images (multimodal), folded from MESSAGE_IMAGES on replay. */
  images?: MessageImage[];
}

/**
 * Load a conversation's history as AG-UI messages, so switching to (or reviving)
 * it shows its prior turns. The agent-host stores the conversation as a stream
 * of AG-UI events; fold the TEXT_MESSAGE_* events back into one message per
 * messageId (tool/reasoning events are rendered live, not replayed as text).
 */
export async function loadHistory(
  config: AgentHostConfig,
  conversationId: string,
): Promise<AguiMessage[]> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(
    conversationId,
  )}/history`;
  let events: Array<Record<string, unknown>>;
  try {
    const res = await fetch(url, {
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined,
    });
    if (!res.ok) {
      // Finding #15: a non-OK history fetch is a real failure — reviving a real
      // conversation would show a BLANK thread, indistinguishable from empty.
      // Log it (the UI still degrades to [] so it doesn't break; a refresh
      // retries) so the blank-thread case is diagnosable instead of silent.
      console.warn(`[client] loadHistory ${conversationId}: HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as { events?: Array<Record<string, unknown>> };
    events = body.events ?? [];
  } catch (e) {
    console.warn(`[client] loadHistory ${conversationId} failed:`, e);
    return [];
  }

  // Fold TEXT_MESSAGE_START -> CONTENT* -> END into one message per id, in order.
  const order: string[] = [];
  const byId = new Map<string, AguiMessage>();
  for (const e of events) {
    const id = e.messageId as string | undefined;
    switch (e.type) {
      case "TEXT_MESSAGE_START": {
        if (!id) break;
        const role = (e.role as AguiMessage["role"]) ?? "assistant";
        if (!byId.has(id)) {
          byId.set(id, { id, role, content: "" });
          order.push(id);
        }
        break;
      }
      case "TEXT_MESSAGE_CONTENT": {
        if (!id) break;
        const m = byId.get(id);
        if (m) m.content += (e.delta as string) ?? "";
        break;
      }
      // Attached images: fold onto the matching user message (it was emitted right
      // after the message's TEXT_MESSAGE_END, so byId already has it).
      case "MESSAGE_IMAGES": {
        if (!id) break;
        const m = byId.get(id);
        const imgs = (e.images as MessageImage[] | undefined) ?? [];
        if (m && imgs.length) m.images = [...(m.images ?? []), ...imgs];
        break;
      }
      // TEXT_MESSAGE_END / tool / reasoning events need no folding here.
      default:
        break;
    }
  }
  // Keep a message if it has text OR images (an image-only message has empty text).
  return order.map((id) => byId.get(id)!).filter((m) => m.content.trim() !== "" || (m.images?.length ?? 0) > 0);
}

// --- Bring-your-own-Claude: connect a personal Claude agent (Settings) ----------------------

export interface RemoteAgentStatus {
  /** BYO enabled on this deployment? false when the /remote-agent routes 404 (feature off). */
  enabled: boolean;
  /** Is the caller's Claude agent connected right now? */
  connected: boolean;
  /** The owner's most recent REJECTED connection attempt, if any — what lets the page say WHY
   *  a container is not connected instead of a silent "Not connected" indistinguishable from
   *  never having started one. */
  lastAuthFailure: { reason: string; at: string } | null;
}

/** Poll whether the caller has a connected Claude agent. 404 → BYO not enabled (hide the section). */
export async function loadRemoteAgentStatus(config: AgentHostConfig): Promise<RemoteAgentStatus> {
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/remote-agent/status`, {
      headers: authHeaders(config),
    });
    if (res.status === 404) return { enabled: false, connected: false, lastAuthFailure: null };
    if (!res.ok) return { enabled: true, connected: false, lastAuthFailure: null };
    const body = (await res.json()) as {
      connected?: boolean;
      lastAuthFailure?: { reason: string; at: string } | null;
    };
    return { enabled: true, connected: !!body.connected, lastAuthFailure: body.lastAuthFailure ?? null };
  } catch (e) {
    console.warn("[client] loadRemoteAgentStatus failed:", e);
    return { enabled: true, connected: false, lastAuthFailure: null };
  }
}

export interface JoinTokenResult {
  token: string;
  dockerCommand: string;
  wsUrl: string;
}

/** Mint a fresh join token + the copyable docker one-liner for the caller. Throws on 401 (sign in)
 *  / 404 (not enabled) so the caller can message accordingly. */
export async function requestRemoteAgentJoinToken(config: AgentHostConfig): Promise<JoinTokenResult> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/remote-agent/join-token`, {
    method: "POST",
    headers: authHeaders(config),
  });
  if (!res.ok) {
    const detail = res.status === 401 ? "Sign in to connect a Claude agent." : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return (await res.json()) as JoinTokenResult;
}
