/**
 * The Session tab's body: the current conversation's pod lifecycle status with a Start
 * button when down, its resource allotment and size picker, a collapsible Services
 * section, then the caller's further sections. State arrives on the `sandbox` topic.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CircleHelp, Cpu, Gpu, HardDrive, MemoryStick, RotateCw, type LucideIcon } from "lucide-react";

import {
  resumeConversation,
  loadSandboxInfo,
  restartSandbox,
  suspendConversation,
  loadSandboxSizes,
  setSandboxSize,
  loadWebServices,
  startWebService,
  stopWebService,
  type WebService,
  type SandboxResources,
  type WorkspaceVolume,
  type SandboxSizePreset,
  type PendingRestart,
} from "./client.js";
import { useSessions, currentConversation } from "./sessions.js";
import { useConversationTopic } from "./conversationState.js";
import { ServiceRows } from "./ServicesPanel.js";
import { PanelSection } from "./PanelSection.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

export type SandboxState = "running" | "suspended" | "ended" | "starting" | "unknown";

/** The `sandbox` topic, as agent-host publishes it. */
export interface SandboxTopic {
  status: string;
  ready: boolean;
  services: WebService[];
}

const NO_SERVICES: WebService[] = [];

/** Live pod status for the current conversation, a resume action with progress, and the service list with controls. */
export function useSandboxStatus() {
  const { currentId } = useSessions();
  const sandbox = useConversationTopic<SandboxTopic>("sandbox");
  const serverStatus = sandbox && sandbox.status !== "unknown" ? sandbox.status : undefined;
  // False while ContainerCreating, though status says "running".
  const ready = sandbox?.ready ?? false;
  const services = sandbox?.services ?? NO_SERVICES;
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setStarting(false); // reset on conversation switch
  }, [currentId]);

  // The resume is done only when the pod is actually ready.
  useEffect(() => {
    if (serverStatus === "running" && ready) setStarting(false);
  }, [serverStatus, ready]);

  // The host pushes what a forced re-read finds.
  const [rescanning, setRescanning] = useState(false);
  const rescanServices = useCallback(async () => {
    setRescanning(true);
    try {
      await currentConversation()?.ifCreated(
        (id) => loadWebServices({ baseUrl: BASE_URL }, id, { refresh: true }),
        [] as Awaited<ReturnType<typeof loadWebServices>>,
      );
    } finally {
      setRescanning(false);
    }
  }, [currentId]);

  const startSandbox = useCallback(async () => {
    const conv = currentConversation();
    if (!conv) return;
    setStarting(true);
    // Starting the sandbox creates the conversation if it does not exist yet.
    const res = await conv
      .withId((id) => resumeConversation({ baseUrl: BASE_URL }, id))
      .catch(() => null);
    if (!res) setStarting(false);
  }, [currentId]);

  const act = async (name: string, fn: typeof startWebService) => {
    setBusy((b) => ({ ...b, [name]: true }));
    await currentConversation()
      ?.withId((id) => fn({ baseUrl: BASE_URL }, id, name))
      .catch(() => undefined);
    setBusy((b) => ({ ...b, [name]: false }));
  };

  // A pod that is "running" but not ready, or a resume in flight, shows as "starting".
  const state: SandboxState =
    serverStatus === "running"
      ? ready
        ? "running"
        : "starting"
      : starting
        ? "starting"
        : (serverStatus as SandboxState) ?? "unknown";

  return {
    state,
    starting,
    services,
    busy,
    rescanServices,
    rescanning,
    conversationId: currentId ?? undefined,
    startSandbox,
    startService: (name: string) => void act(name, startWebService),
    stopService: (name: string) => void act(name, stopWebService),
    hasConversation: !!currentId,
  };
}

const DOT: Record<SandboxState, string> = {
  running: "bg-success",
  suspended: "bg-warning",
  ended: "bg-muted-foreground/40",
  starting: "bg-warning animate-pulse",
  unknown: "bg-muted-foreground/40 animate-pulse",
};

/** Status-banner tint per state. */
const BANNER: Record<SandboxState, string> = {
  running: "border-success/30 bg-success/10",
  suspended: "border-warning/30 bg-warning/10",
  starting: "border-warning/30 bg-warning/10",
  ended: "border-border bg-muted/40",
  unknown: "border-border bg-muted/30",
};

const BANNER_TEXT: Record<SandboxState, string> = {
  running: "Sandbox running",
  suspended: "Sandbox suspended",
  starting: "Starting sandbox…",
  ended: "Sandbox ended",
  unknown: "Checking sandbox…",
};

/** Whether a resources object carries any value worth showing. */
function hasResources(r: SandboxResources | null | undefined): r is SandboxResources {
  if (!r) return false;
  const sides = [r.requests, r.limits];
  return sides.some((q) => q && (q.cpu !== undefined || q.memory !== undefined || q.gpu !== undefined));
}

/** The /workspace size, e.g. "10Gi (resizing to 20Gi)". */
function formatWorkspace(w: WorkspaceVolume | null | undefined): string {
  if (!w) return "";
  const size = w.capacity ?? w.requested;
  return w.capacity && w.capacity !== w.requested ? `${size} (resizing to ${w.requested})` : size;
}

/** One icon-labelled figure; the hover text names it. */
function ResourceItem({ icon: Icon, value, label, testId }: { icon: LucideIcon; value: string; label: string; testId: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1" tabIndex={0} aria-label={`${label}: ${value}`} data-testid={testId}>
          <Icon className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="font-mono text-foreground">{value}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/** The sandbox's limits and /workspace size on one line. */
export function ResourcesSection({ resources, workspace }: { resources: SandboxResources | null | undefined; workspace?: WorkspaceVolume | null }) {
  // Limits are the effective size; requests fill in an unset limit.
  const pick = <K extends "cpu" | "memory" | "gpu">(k: K) => resources?.limits?.[k] ?? resources?.requests?.[k];
  const cpu = pick("cpu");
  const memory = pick("memory");
  const gpu = pick("gpu");
  const disk = formatWorkspace(workspace);
  return (
    <TooltipProvider delayDuration={150}>
      <div data-testid="sandbox-resources" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {cpu ? <ResourceItem icon={Cpu} value={`${cpu} CPU`} label="CPU limit" testId="sandbox-resources-cpu" /> : null}
        {memory ? <ResourceItem icon={MemoryStick} value={memory} label="Memory limit" testId="sandbox-resources-memory" /> : null}
        {gpu ? <ResourceItem icon={Gpu} value={`${gpu} GPU`} label="GPU limit" testId="sandbox-resources-gpu" /> : null}
        {disk ? <ResourceItem icon={HardDrive} value={disk} label="/workspace storage" testId="sandbox-resources-workspace" /> : null}
      </div>
    </TooltipProvider>
  );
}

/** The preset name whose cpu/memory/gpu match the current allotment, or "" when none does (shown as "Custom"). */
export function matchPreset(
  sizes: Record<string, SandboxSizePreset>,
  resources: SandboxResources | null | undefined,
): string {
  const limits = resources?.limits;
  if (!limits) return "";
  return (
    Object.keys(sizes).find((name) => {
      const p = sizes[name];
      return p.cpu === limits.cpu && p.memory === limits.memory && (p.gpu ?? undefined) === (limits.gpu ?? undefined);
    }) ?? ""
  );
}

/** One preset rendered for the dropdown: "medium — 2 CPU · 4Gi · 1 GPU". */
function formatPreset(name: string, p: SandboxSizePreset): string {
  const parts = [`${p.cpu} CPU`, p.memory];
  if (p.gpu) parts.push(`${p.gpu} GPU`);
  return `${name} — ${parts.join(" · ")}`;
}

export interface SizeSectionProps {
  sizes: Record<string, SandboxSizePreset>;
  /** The currently-applied allotment, used to derive the selected option. */
  resources?: SandboxResources | null;
  onSelect: (size: string) => void;
  /** A write is in flight, so the select is disabled. */
  saving?: boolean;
  /** The server's rejection message, shown inline rather than silently reverting. */
  error?: string | null;
  /** A size was recorded and is waiting for the next restart to take effect. */
  pendingRestart?: boolean;
  /** Apply the pending size now; absent hides the button. */
  onRestart?: () => void;
  restarting?: boolean;
}

/** The sandbox size picker over the deployment's named presets. */
export function SizeSection({ sizes, resources, onSelect, saving, error, pendingRestart, onRestart, restarting }: SizeSectionProps) {
  const names = Object.keys(sizes);
  const selected = matchPreset(sizes, resources);
  // Absent for "Custom" and for presets without a hint.
  const hint = selected ? (sizes[selected]?.hint ?? "") : "";
  return (
    <div data-testid="sandbox-size">
      <div className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
        Size
        {/* An <option> cannot wrap, so the preset's guidance is a tooltip. */}
        {hint ? <HelpTip text={hint} testId="sandbox-size-hint" /> : null}
      </div>
      <select
        data-testid="sandbox-size-select"
        className="w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground disabled:opacity-50"
        value={selected}
        disabled={saving}
        onChange={(e) => onSelect(e.target.value)}
      >
        {/* Present only when the applied size matches no preset, and not selectable. */}
        {selected === "" ? (
          <option value="" disabled>
            Custom
          </option>
        ) : null}
        {names.map((name) => (
          <option key={name} value={name}>
            {formatPreset(name, sizes[name])}
          </option>
        ))}
      </select>
      {error ? (
        <p className="mt-1 text-xs text-destructive" data-testid="sandbox-size-error">
          {error}
        </p>
      ) : pendingRestart ? (
        <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground" data-testid="sandbox-size-pending">
          Takes effect when the sandbox next restarts.
          {onRestart ? (
            <Button
              variant="outline"
              size="xs"
              data-testid="sandbox-size-restart"
              disabled={restarting}
              onClick={onRestart}
            >
              {restarting ? "Restarting…" : "Restart now"}
            </Button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/** A ? icon that shows `text` on hover or focus. */
function HelpTip({ text, testId }: { text: string; testId: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label={text} data-testid={testId} className="text-muted-foreground hover:text-foreground">
            <CircleHelp className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The "Update available" banner with a restart button. */
export function UpdateBanner({
  pending,
  restarting,
  onRestart,
}: {
  pending: PendingRestart;
  restarting: boolean;
  onRestart?: () => void;
}) {
  const update = !!(pending.image || pending.env || pending.template?.length);
  const what = [update ? "the latest sandbox image and settings" : null, pending.size ? "your new size" : null]
    .filter(Boolean)
    .join(" and ");
  return (
    <div
      data-testid="sandbox-update-banner"
      className="flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-1.5"
    >
      <span className="text-sm font-medium">{update ? "Update available" : "Size change pending"}</span>
      <HelpTip
        testId="sandbox-update-hint"
        text={`A restart picks up ${what}. /workspace, installed modules and /nix/store builds persist; running processes, background jobs and web services stop.`}
      />
      {onRestart ? (
        <Button
          variant="default"
          size="xs"
          data-testid="sandbox-restart"
          disabled={restarting}
          onClick={onRestart}
          className="ml-auto"
        >
          {restarting ? "Restarting…" : "Restart sandbox"}
        </Button>
      ) : null}
    </div>
  );
}

export interface SandboxPanelViewProps {
  state: SandboxState;
  services: WebService[];
  busy: Record<string, boolean>;
  conversationId?: string;
  /** The conversation's owner, or undefined/null when unowned. */
  owner?: string | null;
  /** The sandbox's resource allotment, not shown when null or empty. */
  resources?: SandboxResources | null;
  /** The /workspace volume's size, not shown when null. */
  workspace?: WorkspaceVolume | null;
  /** The deployment's named size presets; empty hides the size picker. */
  sizes?: Record<string, SandboxSizePreset>;
  onSelectSize?: (size: string) => void;
  sizeSaving?: boolean;
  sizeError?: string | null;
  sizePendingRestart?: boolean;
  /** Pending restart changes; drives the update banner. */
  pendingRestart?: PendingRestart | null;
  /** A restart is in flight. */
  restarting?: boolean;
  /** A failed restart or stop, shown inline. */
  lifecycleError?: string | null;
  onRestartSandbox?: () => void;
  onStopSandbox?: () => void;
  onStartSandbox: () => void;
  onStartService: (name: string) => void;
  onStopService: (name: string) => void;
  /** Re-read the in-pod service manifest to pick up a just-declared service without waiting. */
  onRescanServices?: () => void;
  rescanning?: boolean;
  /** Further Session-tab sections, rendered after Services. */
  children?: ReactNode;
}

/** Pure view: the status banner and, when running, the service list, else a Start prompt. */
export function SandboxPanelView({
  state,
  services,
  busy,
  conversationId,
  owner,
  resources,
  workspace,
  sizes,
  onSelectSize,
  sizeSaving,
  sizeError,
  sizePendingRestart,
  pendingRestart,
  restarting,
  lifecycleError,
  onRestartSandbox,
  onStopSandbox,
  onStartSandbox,
  onStartService,
  onStopService,
  onRescanServices,
  rescanning,
  children,
}: SandboxPanelViewProps) {
  // The "+ Service" card reveals an explainer, since services are declared in-sandbox rather than created here.
  const [showAddHint, setShowAddHint] = useState(false);

  return (
    <div className="flex flex-col gap-4" data-testid="sandbox-panel">
      {/* The status banner hosts the contextual action: Start when down, Rescan when running. */}
      <div
        data-testid="sandbox-status-banner"
        className={cn("flex items-center gap-2 rounded-lg border px-3 py-2.5", BANNER[state])}
      >
        <span className={cn("inline-block h-2.5 w-2.5 rounded-full", DOT[state])} aria-hidden />
        <span className="min-w-0 truncate text-sm font-medium" data-testid="sandbox-state" data-state={state}>
          {BANNER_TEXT[state]}
        </span>
        {(state === "suspended" || state === "starting") && (
          <Button
            variant="default"
            size="xs"
            data-testid="sandbox-start"
            disabled={state === "starting"}
            onClick={onStartSandbox}
            className="ml-auto shrink-0"
          >
            {state === "starting" ? "Starting…" : "Start"}
          </Button>
        )}
        {state === "running" && onRescanServices ? (
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="sandbox-rescan-services"
            disabled={rescanning}
            onClick={onRescanServices}
            title="Re-read the sandbox's service manifest (after scooter-rebuild)"
            aria-label="Rescan services"
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            {rescanning ? <span className="text-xs">Rescanning…</span> : <RotateCw className="size-4" aria-hidden />}
          </Button>
        ) : null}
        {state === "running" && onStopSandbox && !restarting ? (
          <Button
            variant="ghost"
            size="xs"
            data-testid="sandbox-stop"
            onClick={onStopSandbox}
            title="Stop the sandbox pod to free its capacity; /workspace persists"
            className={cn("text-muted-foreground hover:text-foreground", onRescanServices ? "" : "ml-auto")}
          >
            Stop
          </Button>
        ) : null}
      </div>

      {/* Only while running: a stopped sandbox picks it up on start anyway. */}
      {state === "running" && pendingRestart && (pendingRestart.image || pendingRestart.env || pendingRestart.template?.length || pendingRestart.size) ? (
        <UpdateBanner
          pending={pendingRestart}
          restarting={!!restarting}
          onRestart={onRestartSandbox}
        />
      ) : null}
      {lifecycleError ? (
        <p className="text-xs text-destructive" data-testid="sandbox-lifecycle-error">
          {lifecycleError}
        </p>
      ) : null}

      {owner || hasResources(resources) || workspace ? (
        <div className="flex flex-col gap-1.5">
          {/* Hidden when unowned. */}
          {owner ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="sandbox-owner">
              <span className="font-medium">Owner</span>
              <span data-testid="sandbox-owner-value">{owner}</span>
            </div>
          ) : null}
          {/* Shown while suspended too: the size applies to the next pod. */}
          {hasResources(resources) || workspace ? <ResourcesSection resources={resources} workspace={workspace} /> : null}
        </div>
      ) : null}

      {/* Only when the deployment configured presets and a write path is wired. */}
      {sizes && Object.keys(sizes).length > 0 && onSelectSize ? (
        <SizeSection
          sizes={sizes}
          resources={resources}
          onSelect={onSelectSize}
          saving={sizeSaving}
          error={sizeError}
          pendingRestart={sizePendingRestart}
          onRestart={state === "running" ? onRestartSandbox : undefined}
          restarting={restarting}
        />
      ) : null}

      {/* Services when running, a hint otherwise. */}
      <PanelSection id="services" label="Services" count={state === "running" ? services.length : 0}>
        {state === "running" ? (
          <div className="flex flex-col gap-2">
            {services.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="sandbox-no-services">
                No web services declared in this sandbox.
              </p>
            ) : null}
            <ServiceRows
              services={services}
              starting={busy}
              onStart={onStartService}
              onStop={onStopService}
              onAdd={() => setShowAddHint((v) => !v)}
            />
            {showAddHint ? (
              <p
                data-testid="service-add-hint"
                className="rounded-md border bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground"
              >
                Web services are declared inside the sandbox — ask Scooter
                to add one (e.g. a terminal or VS Code) with <span className="font-mono">scooter-rebuild</span>.
                {onRescanServices ? <> Use the <RotateCw className="inline size-3" role="img" aria-label="Re-scan" /> button above to re-scan once it&apos;s added.</> : ""}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {state === "suspended"
              ? "The sandbox pod is suspended (idle). Start it to reach its web services."
              : state === "starting"
                ? "Bringing the sandbox pod up… services appear once it's running."
                : state === "ended"
                  ? "This conversation was ended; its sandbox is gone."
                  : "Checking the sandbox status…"}
          </p>
        )}
      </PanelSection>
      {children}
    </div>
  );
}

export interface SandboxPanelProps {
  /** The host's sandbox status, so both share one Start state. */
  status: ReturnType<typeof useSandboxStatus>;
  /** Further Session-tab sections, rendered after Services. */
  children?: ReactNode;
}

/** Loads resources, sizes and pending restarts; wires restart and stop. */
export function SandboxPanel({ status: s, children }: SandboxPanelProps) {
  const { sessions, currentId } = useSessions();
  const owner = sessions.find((x) => x.id === currentId)?.owner ?? null;

  // Re-fetched when the pod comes up, since the broker applies a pending size on restart.
  const [resources, setResources] = useState<SandboxResources | null>(null);
  const [pendingRestart, setPendingRestart] = useState<PendingRestart | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceVolume | null>(null);
  // Bumped after a restart to re-read the info.
  const [infoNonce, setInfoNonce] = useState(0);
  useEffect(() => {
    setPendingRestart(null); // reset on conversation switch
  }, [currentId]);
  useEffect(() => {
    if (!currentId) return;
    let alive = true;
    void currentConversation()
      ?.ifCreated(
        (id) => loadSandboxInfo({ baseUrl: BASE_URL }, id),
        null as Awaited<ReturnType<typeof loadSandboxInfo>> | null,
      )
      .then((r) => {
        if (!alive || !r) return;
        setResources(r.resources);
        setPendingRestart(r.pendingRestart);
        setWorkspace(r.workspace);
      });
    return () => {
      alive = false;
    };
  }, [currentId, s.state, infoNonce]);

  const [restarting, setRestarting] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  useEffect(() => {
    setLifecycleError(null);
    setRestarting(false);
  }, [currentId]);

  const onRestart = () => {
    const conv = currentConversation();
    if (!conv || restarting) return;
    setRestarting(true);
    setLifecycleError(null);
    void conv
      .ifCreated((id) => restartSandbox({ baseUrl: BASE_URL }, id), "no conversation" as string | null)
      .then((err) => {
        setRestarting(false);
        if (err) {
          setLifecycleError(err);
          return;
        }
        setSizePendingRestart(false);
        setInfoNonce((n) => n + 1);
      });
  };

  const onStop = () => {
    const conv = currentConversation();
    if (!conv) return;
    setLifecycleError(null);
    void conv
      .ifCreated((id) => suspendConversation({ baseUrl: BASE_URL }, id), "no conversation" as string | null)
      .then((err) => {
        if (err) setLifecycleError(err);
      });
  };

  // The preset table is deployment-wide, so it is fetched once.
  const [sizes, setSizes] = useState<Record<string, SandboxSizePreset>>({});
  useEffect(() => {
    let alive = true;
    void loadSandboxSizes({ baseUrl: BASE_URL }).then((r) => {
      if (alive) setSizes(r.sizes);
    });
    return () => {
      alive = false;
    };
  }, []);

  const [sizeSaving, setSizeSaving] = useState(false);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [sizePendingRestart, setSizePendingRestart] = useState(false);

  const onSelectSize = (size: string) => {
    const preset = sizes[size];
    // Bail before setting `saving`, or the select would stay disabled with no request in flight to re-enable it.
    const conv = currentConversation();
    if (!preset || !conv) return;
    setSizeSaving(true);
    setSizeError(null);
    void conv
      .ifCreated((id) => setSandboxSize({ baseUrl: BASE_URL }, id, size), "no conversation" as string | null)
      .then((err) => {
        setSizeSaving(false);
        if (err) {
          setSizeError(err);
          return;
        }
        setSizePendingRestart(true);
        // Reflect the pick immediately, because re-reading /resources would return the old size until the next restart.
        setResources({
          requests: { cpu: preset.cpu, memory: preset.memory, gpu: preset.gpu },
          limits: { cpu: preset.cpu, memory: preset.memory, gpu: preset.gpu },
        });
      });
  };

  return (
    <SandboxPanelView
      state={s.state}
      services={s.services}
      busy={s.busy}
      onRescanServices={s.rescanServices}
      rescanning={s.rescanning}
      conversationId={s.conversationId}
      owner={owner}
      resources={resources}
      workspace={workspace}
      sizes={sizes}
      onSelectSize={onSelectSize}
      sizeSaving={sizeSaving}
      sizeError={sizeError}
      sizePendingRestart={sizePendingRestart}
      pendingRestart={pendingRestart}
      restarting={restarting}
      lifecycleError={lifecycleError}
      onRestartSandbox={onRestart}
      onStopSandbox={onStop}
      onStartSandbox={() => void s.startSandbox()}
      onStartService={s.startService}
      onStopService={s.stopService}
    >
      {children}
    </SandboxPanelView>
  );
}
