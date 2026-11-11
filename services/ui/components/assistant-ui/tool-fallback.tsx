"use client";

import { createContext, memo, useCallback, useContext, useId, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  LoaderIcon,
  XCircleIcon,
} from "lucide-react";
import {
  useScrollLock,
  useToolCallElapsed,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { cn } from "@/lib/utils";
import { MediaStrip, MediaVideo } from "@/components/assistant-ui/media-gallery";
import { FoldedContent } from "@/src/FoldedContent";
import { splitResultImages } from "@/src/mediaRefs";

const ANIMATION_DURATION = 200;
/** The agent-host API base the assets route is served under ("" in prod). */
const ASSET_BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

/**
 * The card's fold state, shared by Root (owner), Trigger (toggles it) and Content
 * (hidden until-found while closed). Not a Radix Collapsible: that unmounts its content
 * when closed, and the body has to stay in the DOM for find-in-page to reach it.
 */
const FoldContext = createContext<{ open: boolean; setOpen: (open: boolean) => void; contentId: string } | null>(null);

function useFold() {
  const ctx = useContext(FoldContext);
  if (!ctx) throw new Error("ToolFallback parts must be rendered inside ToolFallback.Root");
  return ctx;
}

export type ToolFallbackRootProps = Omit<React.ComponentProps<"div">, "onChange"> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
};

function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolFallbackRootProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const lockScroll = useScrollLock(rootRef, ANIMATION_DURATION);
  const contentId = useId();

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      lockScroll();
      if (!isControlled) {
        setUncontrolledOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [lockScroll, isControlled, controlledOnOpenChange],
  );

  const fold = useMemo(
    () => ({ open: isOpen, setOpen: handleOpenChange, contentId }),
    [isOpen, handleOpenChange, contentId],
  );

  return (
    <FoldContext.Provider value={fold}>
      <div
        ref={rootRef}
        data-slot="tool-fallback-root"
        data-state={isOpen ? "open" : "closed"}
        className={cn(
          "aui-tool-fallback-root group/tool-fallback-root w-full",
          className,
        )}
        style={
          {
            "--animation-duration": `${ANIMATION_DURATION}ms`,
          } as React.CSSProperties
        }
        {...props}
      >
        {children}
      </div>
    </FoldContext.Provider>
  );
}

type ToolStatus = ToolCallMessagePartStatus["type"];

const statusIconMap: Record<ToolStatus, React.ElementType> = {
  running: LoaderIcon,
  complete: CheckIcon,
  incomplete: XCircleIcon,
  "requires-action": AlertCircleIcon,
};

const formatToolDuration = (ms: number) => {
  if (ms < 1000) return "<1s";
  const seconds = ms / 1000;
  if (seconds < 10) return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
};

function ToolFallbackDuration({
  className,
  ...props
}: React.ComponentProps<"span">) {
  const elapsedMs = useToolCallElapsed();
  if (elapsedMs === undefined) return null;

  return (
    <span
      data-slot="tool-fallback-duration"
      className={cn(
        "aui-tool-fallback-duration text-muted-foreground text-xs tabular-nums",
        className,
      )}
      {...props}
    >
      {formatToolDuration(elapsedMs)}
    </span>
  );
}

function ToolFallbackTrigger({
  toolName,
  status,
  className,
  onClick,
  ...props
}: React.ComponentProps<"button"> & {
  toolName: string;
  status?: ToolCallMessagePartStatus;
}) {
  const { open, setOpen, contentId } = useFold();
  const statusType = status?.type ?? "complete";
  const isRunning = statusType === "running";
  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";

  const Icon = statusIconMap[statusType];
  const label = isCancelled ? "Cancelled tool" : "Used tool";

  return (
    <button
      type="button"
      data-slot="tool-fallback-trigger"
      data-state={open ? "open" : "closed"}
      aria-expanded={open}
      aria-controls={contentId}
      className={cn(
        "aui-tool-fallback-trigger group/trigger text-muted-foreground hover:text-foreground flex w-fit origin-left items-center gap-2 py-1.5 text-sm transition-[color,scale] active:scale-[0.98]",
        className,
      )}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) setOpen(!open);
      }}
      {...props}
    >
      <Icon
        data-slot="tool-fallback-trigger-icon"
        className={cn(
          "aui-tool-fallback-trigger-icon size-4 shrink-0",
          isCancelled && "text-muted-foreground",
          isRunning && "animate-spin [animation-duration:0.6s]",
        )}
      />
      <span
        data-slot="tool-fallback-trigger-label"
        className={cn(
          "aui-tool-fallback-trigger-label-wrapper relative inline-block text-start leading-none",
          isCancelled && "text-muted-foreground line-through",
        )}
      >
        <span>
          {label}: <b>{toolName}</b>
        </span>
        {isRunning && (
          <span
            aria-hidden
            data-slot="tool-fallback-trigger-shimmer"
            className="aui-tool-fallback-trigger-shimmer shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
          >
            {label}: <b>{toolName}</b>
          </span>
        )}
      </span>
      <ToolFallbackDuration />
      <ChevronDownIcon
        data-slot="tool-fallback-trigger-chevron"
        className={cn(
          "aui-tool-fallback-trigger-chevron size-4 shrink-0",
          "transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          "group-data-[state=closed]/trigger:-rotate-90",
          "group-data-[state=open]/trigger:rotate-0",
        )}
      />
    </button>
  );
}

/**
 * The card's body: args, result, error. Closed, it stays mounted under
 * hidden="until-found" so find-in-page can land in a tool's output and open the card.
 */
function ToolFallbackContent({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "hidden">) {
  const { open, setOpen, contentId } = useFold();
  return (
    <FoldedContent
      id={contentId}
      open={open}
      onReveal={() => setOpen(true)}
      data-slot="tool-fallback-content"
      className={cn(
        "aui-tool-fallback-content relative overflow-hidden text-sm outline-none",
        "group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "flex flex-col gap-2 ps-6 pt-1 pb-2 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
          "group-data-[state=open]/collapsible-content:animate-in group-data-[state=open]/collapsible-content:fade-in-0 group-data-[state=open]/collapsible-content:blur-in-[2px] group-data-[state=open]/collapsible-content:slide-in-from-top-1",
          "group-data-[state=closed]/collapsible-content:animate-out group-data-[state=closed]/collapsible-content:fade-out-0 group-data-[state=closed]/collapsible-content:blur-out-[2px] group-data-[state=closed]/collapsible-content:slide-out-to-top-1",
          "group-data-[state=closed]/collapsible-content:duration-(--animation-duration) group-data-[state=open]/collapsible-content:duration-(--animation-duration)",
        )}
      >
        {children}
      </div>
    </FoldedContent>
  );
}

function ToolFallbackArgs({
  argsText,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  argsText?: string;
}) {
  if (!argsText) return null;

  return (
    <div
      data-slot="tool-fallback-args"
      className={cn("aui-tool-fallback-args", className)}
      {...props}
    >
      <pre className="aui-tool-fallback-args-value bg-muted/50 text-foreground/90 rounded-md p-2.5 text-xs whitespace-pre-wrap">
        {argsText}
      </pre>
    </div>
  );
}

function ToolFallbackResult({
  result,
  showImages = true,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  result?: unknown;
  /** False when the card already shows the result's images outside the collapsed body. */
  showImages?: boolean;
}) {
  if (result === undefined) return null;
  // Images the agent-host stored out of the result render inline; the rest stays text.
  const { images, videos, omitted, rest } = splitResultImages(result, ASSET_BASE_URL);

  return (
    <div
      data-slot="tool-fallback-result"
      className={cn("aui-tool-fallback-result", className)}
      {...props}
    >
      <p className="aui-tool-fallback-result-header text-muted-foreground text-xs font-medium">
        Result:
      </p>
      {showImages && <MediaStrip images={images.map((i) => ({ src: i.src, alt: "" }))} className="mt-1" />}
      {showImages && videos.map((v) => <MediaVideo key={v.src} src={v.src} mimeType={v.mimeType} />)}
      {omitted.length > 0 && (
        <p data-slot="tool-fallback-result-omitted" className="text-muted-foreground mt-1 text-xs italic">
          {omitted.length === 1 ? "1 image" : `${omitted.length} images`} not shown ({[...new Set(omitted)].join(", ")})
        </p>
      )}
      {rest !== undefined && (
        <pre className="aui-tool-fallback-result-content bg-muted/50 text-foreground/90 mt-1 rounded-md p-2.5 text-xs whitespace-pre-wrap">
          {typeof rest === "string" ? rest : JSON.stringify(rest, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolFallbackError({
  status,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  status?: ToolCallMessagePartStatus;
}) {
  if (status?.type !== "incomplete") return null;

  const error = status.error;
  const errorText = error
    ? typeof error === "string"
      ? error
      : JSON.stringify(error)
    : null;

  if (!errorText) return null;

  const isCancelled = status.reason === "cancelled";
  const headerText = isCancelled ? "Cancelled reason:" : "Error:";

  return (
    <div
      data-slot="tool-fallback-error"
      className={cn("aui-tool-fallback-error", className)}
      {...props}
    >
      <p className="aui-tool-fallback-error-header text-muted-foreground font-semibold">
        {headerText}
      </p>
      <p className="aui-tool-fallback-error-reason text-muted-foreground">
        {errorText}
      </p>
    </div>
  );
}

const ToolFallbackImpl: ToolCallMessagePartComponent & {
  (props: ToolCallMessagePartProps & { forceRunning?: boolean }): React.ReactNode;
} = ({
  toolName,
  argsText,
  result,
  status,
  // The folded part's `status` is always "complete", so ToolCallView passes the real liveness here to force "running".
  forceRunning,
}: ToolCallMessagePartProps & { forceRunning?: boolean }) => {
  const effectiveStatus: ToolCallMessagePartStatus | undefined = forceRunning
    ? ({ type: "running" } as ToolCallMessagePartStatus)
    : status;
  const isCancelled =
    effectiveStatus?.type === "incomplete" && effectiveStatus.reason === "cancelled";

  // A finished result's images and videos show under the header even while the card is collapsed (the
  // default), so a screenshot the agent viewed is visible without opening the tool call.
  const showsResult = !isCancelled && !forceRunning;
  const { images, videos } = showsResult ? splitResultImages(result, ASSET_BASE_URL) : { images: [], videos: [] };

  return (
    <ToolFallbackRoot>
      <ToolFallbackTrigger toolName={toolName} status={effectiveStatus} />
      <MediaStrip
        images={images.map((i) => ({ src: i.src, alt: "" }))}
        className="aui-tool-fallback-images mb-1"
      />
      {videos.map((v) => (
        <MediaVideo key={v.src} src={v.src} mimeType={v.mimeType} className="aui-tool-fallback-video mt-0 mb-1" />
      ))}
      <ToolFallbackContent>
        <ToolFallbackError status={effectiveStatus} />
        <ToolFallbackArgs
          argsText={argsText}
          className={cn(isCancelled && "opacity-60")}
        />
        {/* While running there is no result yet, so the folded result is stale or absent. */}
        {showsResult && <ToolFallbackResult result={result} showImages={false} />}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

/** The stock part props plus the `forceRunning` override, so ToolCallView can drive the spinner from our own run state. */
type ToolFallbackComponent = ((
  props: ToolCallMessagePartProps & { forceRunning?: boolean },
) => React.ReactNode) & {
  displayName?: string;
};

const ToolFallback = memo(
  ToolFallbackImpl,
) as unknown as ToolFallbackComponent & {
  Root: typeof ToolFallbackRoot;
  Trigger: typeof ToolFallbackTrigger;
  Content: typeof ToolFallbackContent;
  Args: typeof ToolFallbackArgs;
  Result: typeof ToolFallbackResult;
  Error: typeof ToolFallbackError;
};

ToolFallback.displayName = "ToolFallback";
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Args = ToolFallbackArgs;
ToolFallback.Result = ToolFallbackResult;
ToolFallback.Error = ToolFallbackError;

export {
  ToolFallback,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackArgs,
  ToolFallbackResult,
  ToolFallbackError,
};
