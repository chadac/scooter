/**
 * The agent-host HTTP client: an @ag-ui/client HttpAgent against POST /agui plus
 * typed fetch helpers for the management API (conversations, models, links, web
 * services, sandbox sizing, scheduled tasks, remote agents).
 */

import { HttpAgent } from "@ag-ui/client";
import type { Theme, ThemeChoice } from "./theme.js";

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
  /** Sandbox lifecycle state, where "failed" is terminal with no pod. */
  status: "running" | "suspended" | "failed" | "ended";
  createdAt: number;
  lastActivityAt: number;
  /** The conversation's model (undefined = host default). */
  model?: string;
  /** Distinct providers this conversation links to, for the sidebar icons. */
  sources?: string[];
  /** Compact summary of the conversation's linked resources, so the sidebar needs no per-row /links fetch. */
  links?: ConversationLink[];
}

/** The model catalog (GET /models): the default + the offered models. */
export interface ModelCatalog {
  default: string | null;
  available: string[];
  /** Model id -> the provider tags that offer it; empty or absent means every provider. */
  providers?: Record<string, string[]>;
  /** Model id -> the provider tags it is the default for, so the picker can mark "(default)" per group. */
  defaultFor?: Record<string, string[]>;
  /** The provider serving `default` for this caller, e.g. "byoc" while connected. */
  defaultProvider?: string | null;
}

/** Fetch the offered models, returning an empty catalog when unreachable or unconfigured. */
export async function loadModels(config: AgentHostConfig, conversationId?: string): Promise<ModelCatalog> {
  const query = conversationId ? `?conversation=${encodeURIComponent(conversationId)}` : "";
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/models${query}`, {
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

/** A web service running in the conversation's sandbox, reverse-proxied at /c/<id>/<name>/. */
export interface WebService {
  name: string;
  displayName: string;
  /** Path to open the service in the browser (under the full threadId). */
  url: string;
  running: boolean;
  /** Advisory sentence naming the gap when this service declares more resources than the sandbox caps at. */
  fit?: string;
  /** The same gap in a few words for the service card, present exactly when `fit` is. */
  fitShort?: string;
}

/** List the conversation's declared web services with liveness, empty when unreachable. */
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

/** Manually compact a conversation, resolving { compacted: false } when it is too short and throwing with the server's message on failure. */
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

/** Start a web service, resolving true once the start is issued rather than once healthy. */
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

/** Stop a web service, resolving true once the stop is issued. */
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

/** Create a conversation and return the id the server assigned, or null on failure. */
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

/** Start a person-driven session in a conversation's sandbox, returning its id or the error. */
export async function createSession(
  config: AgentHostConfig,
  parentId: string,
): Promise<{ id: string } | { error: string }> {
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(parentId)}/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify({ origin: "web" }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (res.ok && body.id) return { id: body.id };
    return { error: body.error ?? `request failed (${res.status})` };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Resume a suspended sandbox pod, returning the conversation's new status or null on failure. */
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

/** Rename a conversation with a user title the agent can no longer override, returning the updated view or null. */
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

/** One sidebar folder; the built-in Starred always comes first. */
export interface ConversationFolder {
  id: string;
  name: string;
  /** A Lucide icon name shown instead of the folder glyph. */
  icon?: string;
  kind: "starred" | "user";
  /** Only a folder service changes it; users file conversations. */
  locked?: boolean;
  /** The enclosing folder; absent at the top level. */
  parentId?: string;
  /** Ordered among siblings. */
  position: number;
  /** Idle hours before deletion; 0 is forever, absent inherits. */
  conversationLifetimeHours?: number;
}

/** GET /folders: folders, and conversation id → folder id. */
export interface FolderList {
  folders: ConversationFolder[];
  placements: Record<string, string>;
}

const foldersUrl = (config: AgentHostConfig, id?: string) =>
  `${config.baseUrl.replace(/\/$/, "")}/folders${id ? `/${encodeURIComponent(id)}` : ""}`;

/** Send one folder request, resolving to the response or null on error. */
async function folderRequest(config: AgentHostConfig, label: string, url: string, method: string, body?: unknown): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      method,
      cache: "no-store",
      headers: { ...authHeaders(config), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return res;
    console.warn(`[client] ${label}: HTTP ${res.status}`);
  } catch (e) {
    console.warn(`[client] ${label} failed:`, e);
  }
  return null;
}

/** Fetch the caller's folders, or null on error. */
export async function fetchFolders(config: AgentHostConfig): Promise<FolderList | null> {
  const res = await folderRequest(config, "fetchFolders", foldersUrl(config), "GET");
  return res ? ((await res.json()) as FolderList) : null;
}

/** Create a folder, returning it or null on error (a taken name included). */
export async function createFolder(config: AgentHostConfig, name: string, parentId?: string): Promise<ConversationFolder | null> {
  const res = await folderRequest(config, "createFolder", foldersUrl(config), "POST", { name, parentId });
  return res ? ((await res.json()) as ConversationFolder) : null;
}

/** Patch a folder; a null lifetime inherits. True on success. */
export async function updateFolder(
  config: AgentHostConfig,
  id: string,
  patch: { name?: string; icon?: string; position?: number; parentId?: string; conversationLifetimeHours?: number | null },
): Promise<boolean> {
  return (await folderRequest(config, "updateFolder", foldersUrl(config, id), "PATCH", patch)) !== null;
}

/** Delete a folder; `subfolders` drops its subtree too. True on success. */
export async function deleteFolder(config: AgentHostConfig, id: string, subfolders = false): Promise<boolean> {
  const url = foldersUrl(config, id) + (subfolders ? "?subfolders=delete" : "");
  return (await folderRequest(config, "deleteFolder", url, "DELETE")) !== null;
}

/** File a conversation, or unfile it with null; true on success. */
export async function placeConversation(config: AgentHostConfig, conversationId: string, folderId: string | null): Promise<boolean> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/folder`;
  return (await folderRequest(config, "placeConversation", url, "PUT", { folderId })) !== null;
}

/** Make a conversation private or shared; `confirm` acknowledges that going shared exposes it. Returns the updated view, or null on error. */
export async function setConversationVisibility(
  config: AgentHostConfig,
  conversationId: string,
  visibility: "shared" | "private",
  confirm = false,
): Promise<ConversationView | null> {
  try {
    const res = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/visibility`,
      {
        method: "PATCH",
        headers: { ...authHeaders(config), "content-type": "application/json" },
        body: JSON.stringify({ visibility, ...(confirm ? { confirm: true } : {}) }),
      },
    );
    if (!res.ok) {
      console.warn(`[client] setConversationVisibility ${conversationId}: HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as ConversationView;
  } catch (e) {
    console.warn(`[client] setConversationVisibility ${conversationId} failed:`, e);
    return null;
  }
}

/** End and delete a conversation, returning true when it is gone (204 or 404). */
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

/** Fetch one conversation's current status, used to poll a resume through to "running". */
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

/** One side of a resource allotment (requests or limits), with cpu/memory as k8s quantity strings and gpu as a count. */
export interface ResourceQuantity {
  cpu?: string;
  memory?: string;
  gpu?: number;
}

/** The sandbox's resource allotment. */
export interface SandboxResources {
  requests?: ResourceQuantity;
  limits?: ResourceQuantity;
}

/** The /workspace size: requested, and what the filesystem has. */
export interface WorkspaceVolume {
  requested: string;
  capacity?: string;
}

/** Fetch the conversation's sandbox resource allotment, or null when unavailable. */
export async function loadSandboxResources(
  config: AgentHostConfig,
  conversationId: string,
): Promise<SandboxResources | null> {
  return (await loadSandboxInfo(config, conversationId)).resources;
}

/** What a sandbox restart would pick up. */
export interface PendingRestart {
  image?: { from: string; to: string };
  size?: boolean;
  env?: boolean;
  /** Platform pod-template fields a restart would change. */
  template?: string[];
}

/** Sandbox size, workspace volume and pending restart; nulls on failure. */
export async function loadSandboxInfo(
  config: AgentHostConfig,
  conversationId: string,
): Promise<{ resources: SandboxResources | null; pendingRestart: PendingRestart | null; workspace: WorkspaceVolume | null }> {
  try {
    const res = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/resources`,
      { headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined },
    );
    if (!res.ok) return { resources: null, pendingRestart: null, workspace: null };
    const body = (await res.json()) as {
      resources?: SandboxResources | null;
      pendingRestart?: PendingRestart | null;
      workspace?: WorkspaceVolume | null;
    };
    return { resources: body.resources ?? null, pendingRestart: body.pendingRestart ?? null, workspace: body.workspace ?? null };
  } catch {
    return { resources: null, pendingRestart: null, workspace: null };
  }
}

/** Restarts the sandbox; returns null or the error. */
export async function restartSandbox(config: AgentHostConfig, conversationId: string): Promise<string | null> {
  return postForError(config, `/conversations/${encodeURIComponent(conversationId)}/restart`);
}

/** Suspends the sandbox; returns null or the error. */
export async function suspendConversation(config: AgentHostConfig, conversationId: string): Promise<string | null> {
  return postForError(config, `/conversations/${encodeURIComponent(conversationId)}/suspend`);
}

async function postForError(config: AgentHostConfig, path: string): Promise<string | null> {
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined,
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? `request failed (${res.status})`;
  } catch (e) {
    return (e as Error).message;
  }
}

/** One named size preset from the deployment's kubenix table. */
export interface SandboxSizePreset {
  cpu: string;
  memory: string;
  gpu?: number;
  /** Deployment guidance for when to pick this size. */
  hint?: string;
}

/** The deployment's size presets and which one is the default; an empty map hides the picker. */
export interface SandboxSizes {
  sizes: Record<string, SandboxSizePreset>;
  default: string | null;
}

/** Fetch the deployment's named sandbox size presets, empty on error. */
export async function loadSandboxSizes(config: AgentHostConfig): Promise<SandboxSizes> {
  const empty: SandboxSizes = { sizes: {}, default: null };
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/sandbox-sizes`, {
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined,
    });
    if (!res.ok) return empty;
    const body = (await res.json()) as Partial<SandboxSizes>;
    return { sizes: body.sizes ?? {}, default: body.default ?? null };
  } catch {
    return empty;
  }
}

/** Record a size preset for this conversation (effective on the next sandbox restart), resolving to null or the server's error message. */
export async function setSandboxSize(
  config: AgentHostConfig,
  conversationId: string,
  size: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/size`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        },
        body: JSON.stringify({ size }),
      },
    );
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? `request failed (${res.status})`;
  } catch (e) {
    return (e as Error).message;
  }
}

/** The caller's identity from the trusted ingress header, plus the deployment's upload
 *  caps (absent from an older agent-host). */
export interface Whoami {
  id: string;
  email: string | null;
  anonymous: boolean;
  limits?: { maxFileBytes?: number; maxFilesPerMessage?: number };
  /** Unfiled conversations' idle lifetime in hours, 0 forever. */
  retention?: { defaultLifetimeHours?: number };
}

/** Fetch the caller's identity, falling back to anonymous if unreachable. */
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
  /** Conversation each run prompts; null spawns a new one. */
  conversation_id?: string | null;
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
  /** Conversation to prompt instead of spawning; fixed at creation. */
  conversation_id?: string | null;
}

/** Result of a scheduled-tasks fetch, where `configured` distinguishes a missing scheduler (501) from no tasks. */
export interface ScheduledTasksResult {
  configured: boolean;
  tasks: ScheduledTaskView[];
}

const authHeaders = (config: AgentHostConfig): Record<string, string> =>
  config.token ? { Authorization: `Bearer ${config.token}` } : {};

/** List the caller's scheduled tasks (501 = scheduler not configured). */
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

/** Result of a /users fetch, where `configured` distinguishes a missing identity store (501) from no users. */
export interface UsersResult {
  configured: boolean;
  users: UserView[];
}

/** List the learned Scooter users (501 = no identity store). */
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

/** Fetch one scheduled task with its recent run history, or null if not found. */
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

/** Create a scheduled task, throwing with the server's error message on failure. */
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

/** Patch any subset of a scheduled task's fields, throwing on failure. */
export async function updateScheduledTask(
  config: AgentHostConfig,
  id: string,
  patch: Partial<Omit<ScheduledTaskInput, "conversation_id">>,
): Promise<ScheduledTaskView> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/scheduled-tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders(config) },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  return (await res.json()) as ScheduledTaskView;
}

/** Delete a scheduled task, resolving true on 204 and false if not found. */
export async function deleteScheduledTask(config: AgentHostConfig, id: string): Promise<boolean> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/scheduled-tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(config),
  });
  return res.ok;
}

/** A personal skill, as the agent-host's /user-skills routes return it. */
export interface UserSkillView {
  id: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Fields the settings form sends when creating/editing a personal skill. */
export interface UserSkillInput {
  name: string;
  description: string;
  body: string;
  enabled?: boolean;
}

/** Result of a /user-skills fetch, where `configured` distinguishes a missing store (501) from no skills. */
export interface UserSkillsResult {
  configured: boolean;
  skills: UserSkillView[];
  /** The deployment's own skill names, so the form can warn that this name replaces one. */
  builtinNames: string[];
}

/** List the caller's personal skills (501 = no database, so the feature is off). */
export async function loadUserSkills(config: AgentHostConfig): Promise<UserSkillsResult> {
  const empty = { skills: [], builtinNames: [] };
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/user-skills`, {
      headers: authHeaders(config),
    });
    if (res.status === 501) return { configured: false, ...empty };
    if (!res.ok) {
      console.warn(`[client] loadUserSkills: HTTP ${res.status}`);
      return { configured: true, ...empty };
    }
    const body = (await res.json()) as Partial<UserSkillsResult>;
    return { configured: true, skills: body.skills ?? [], builtinNames: body.builtinNames ?? [] };
  } catch (e) {
    console.warn("[client] loadUserSkills failed:", e);
    return { configured: true, ...empty };
  }
}

/** The server's rejection message, which for a skill is the validation text the form shows. */
const skillError = async (res: Response): Promise<never> => {
  throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
};

/** Create a personal skill, throwing with the server's validation message on refusal. */
export async function createUserSkill(
  config: AgentHostConfig,
  input: UserSkillInput,
): Promise<UserSkillView> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/user-skills`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(config) },
    body: JSON.stringify(input),
  });
  if (!res.ok) await skillError(res);
  return (await res.json()) as UserSkillView;
}

/** Patch any subset of a personal skill's fields (the enabled toggle included). */
export async function updateUserSkill(
  config: AgentHostConfig,
  id: string,
  patch: Partial<UserSkillInput>,
): Promise<UserSkillView> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/user-skills/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders(config) },
    body: JSON.stringify(patch),
  });
  if (!res.ok) await skillError(res);
  return (await res.json()) as UserSkillView;
}

/** Delete a personal skill, answering whether it was there. */
export async function deleteUserSkill(config: AgentHostConfig, id: string): Promise<boolean> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/user-skills/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(config),
  });
  return res.ok;
}

export interface UserHookView {
  id: string;
  event: string;
  description: string;
  /** False means the deployment requires it. */
  userCanDisable: boolean;
  enabled: boolean;
}

/** `configurable` is false without a database. */
export async function loadUserHooks(config: AgentHostConfig): Promise<{ configurable: boolean; hooks: UserHookView[] }> {
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/user-hooks`, { headers: authHeaders(config) });
    if (!res.ok) {
      console.warn(`[client] loadUserHooks: HTTP ${res.status}`);
      return { configurable: false, hooks: [] };
    }
    const body = (await res.json()) as { configurable?: boolean; hooks?: UserHookView[] };
    return { configurable: body.configurable === true, hooks: body.hooks ?? [] };
  } catch (e) {
    console.warn("[client] loadUserHooks failed:", e);
    return { configurable: false, hooks: [] };
  }
}

/** Turn a hook on or off for the caller's future conversations. */
export async function setUserHookEnabled(config: AgentHostConfig, id: string, enabled: boolean): Promise<void> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/user-hooks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders(config) },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) await skillError(res);
}

/** Which conversations to list: the caller's own ("mine", default) or all. */
export type ConversationScope = "mine" | "all";

// There is deliberately no loadConversations() here. The sidebar's list comes from the
// /conversations/events stream only (see conversationStream.ts); a second, periodic reader of
// GET /conversations is the thing PR #780 removed, and re-adding one would restore both the
// request volume and the two-sources-of-truth it cost. GET /conversations itself stays for
// non-UI callers.

/** An image attached to a replayed message, rendered via its `url`. */
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

/** Load a conversation's history as AG-UI messages by folding its TEXT_MESSAGE_* events into one message per messageId. */
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
      // A non-OK history fetch is logged so a blank thread that is really an error stays diagnosable.
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
      // Attached images fold onto the matching message, which byId already has.
      case "MESSAGE_IMAGES": {
        if (!id) break;
        const m = byId.get(id);
        const imgs = (e.images as MessageImage[] | undefined) ?? [];
        if (m && imgs.length) m.images = [...(m.images ?? []), ...imgs];
        break;
      }
      default:
        break;
    }
  }
  // An image-only message has empty text and is kept.
  return order.map((id) => byId.get(id)!).filter((m) => m.content.trim() !== "" || (m.images?.length ?? 0) > 0);
}

// --- Bring-your-own-Claude: connect a personal Claude agent (Settings) ----------------------

export interface RemoteAgentStatus {
  /** False when the /remote-agent routes 404 (feature off). */
  enabled: boolean;
  /** Whether the caller's Claude agent is connected right now. */
  connected: boolean;
  /** The owner's most recent rejected connection attempt, so the page can say why a container is not connected. */
  lastAuthFailure: { reason: string; at: string } | null;
}

/** Poll whether the caller has a connected Claude agent (404 = feature not enabled). */
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

/** Mint a fresh join token and the copyable docker one-liner, throwing on 401 or 404 so the caller can message accordingly. */
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

const PROMPT_ACCEPT_MS = 5000;

/** Queue a user message on a conversation, resolving once the agent-host accepted it. */
export async function promptConversation(config: AgentHostConfig, conversationId: string, text: string): Promise<boolean> {
  const ctl = new AbortController();
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/agui`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify({ threadId: conversationId, messages: [{ role: "user", content: text }] }),
      credentials: "same-origin",
      signal: ctl.signal,
    });
    if (!res.ok || !res.body) {
      console.warn(`[client] promptConversation ${conversationId}: HTTP ${res.status}`);
      return false;
    }
    // A quiet stream means queued; only a first RUN_ERROR is a refusal.
    const reader = res.body.getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), PROMPT_ACCEPT_MS)),
    ]);
    if (!first || first.done) return first === null;
    return !/"type"\s*:\s*"RUN_ERROR"/.test(new TextDecoder().decode(first.value));
  } catch (e) {
    console.warn(`[client] promptConversation ${conversationId} failed:`, e);
    return false;
  } finally {
    ctl.abort();
  }
}

/** One tainting author, as GET /taint returns it. */
export interface TaintAuthor {
  conversationId: string;
  kind: "identity" | "user" | "unknown";
  author: string;
  lastAt: number;
  /** How the owner reads it, e.g. "@someone (github)". */
  label: string;
}

/** Who taints a conversation; `authors` is empty when it acts as its owner. */
export interface TaintView {
  visibility: "shared" | "private";
  summary: string;
  authors: TaintAuthor[];
}

async function taintRequest(config: AgentHostConfig, conversationId: string, path: string, body?: unknown): Promise<TaintView | null> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}/${path}`;
  try {
    const res = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...authHeaders(config), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      console.warn(`[client] ${path} ${conversationId}: HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as TaintView;
  } catch (e) {
    console.warn(`[client] ${path} ${conversationId} failed:`, e);
    return null;
  }
}

/** Who taints the conversation, or null on error. */
export function getConversationTaint(config: AgentHostConfig, conversationId: string): Promise<TaintView | null> {
  return taintRequest(config, conversationId, "taint");
}

/** Clears shown authors; returns what still taints, null on error. */
export function clearConversationTaint(config: AgentHostConfig, conversationId: string, authors: TaintAuthor[]): Promise<TaintView | null> {
  return taintRequest(config, conversationId, "taint/clear", { authors });
}

/** scooter.ui.themes and ui.defaultTheme; undefined when the fetch fails. */
export async function loadThemes(config: AgentHostConfig): Promise<{ themes: Theme[]; default?: string } | undefined> {
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/themes`, { headers: authHeaders(config) });
    if (!res.ok) {
      console.warn(`[client] loadThemes: HTTP ${res.status}`);
      return undefined;
    }
    const body = (await res.json()) as { themes?: Theme[]; default?: string };
    return { themes: body.themes ?? [], default: body.default };
  } catch (e) {
    console.warn("[client] loadThemes failed:", e);
    return undefined;
  }
}

/** The caller's saved choice; unconfigurable without a database. */
export async function loadUserTheme(config: AgentHostConfig): Promise<{ configurable: boolean } & Partial<ThemeChoice>> {
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/user-theme`, { headers: authHeaders(config) });
    if (!res.ok) return { configurable: false };
    return (await res.json()) as { configurable: boolean } & Partial<ThemeChoice>;
  } catch (e) {
    console.warn("[client] loadUserTheme failed:", e);
    return { configurable: false };
  }
}

/** The caller's retention default, and the deployment's it overrides. */
export interface UserRetention {
  configurable: boolean;
  /** 0 keeps unfiled conversations forever. */
  deploymentLifetimeHours: number;
  /** Absent: the deployment's applies. */
  lifetimeHours?: number;
}

export async function loadUserRetention(config: AgentHostConfig): Promise<UserRetention | null> {
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/user-retention`, { headers: authHeaders(config) });
    return res.ok ? ((await res.json()) as UserRetention) : null;
  } catch (e) {
    console.warn("[client] loadUserRetention failed:", e);
    return null;
  }
}

/** Set the caller's default lifetime; null restores the deployment's. */
export async function saveUserRetention(config: AgentHostConfig, lifetimeHours: number | null): Promise<string | null> {
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/user-retention`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...authHeaders(config) },
      body: JSON.stringify({ lifetimeHours }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? `request failed (${res.status})`;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Save part of the caller's theme choice to their account. */
export async function saveUserTheme(config: AgentHostConfig, choice: Partial<ThemeChoice>): Promise<void> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/user-theme`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders(config) },
    body: JSON.stringify(choice),
  });
  if (!res.ok) throw new Error(`saving the theme failed: HTTP ${res.status}`);
}
