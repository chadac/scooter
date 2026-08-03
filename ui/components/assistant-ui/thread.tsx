import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/attachment";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/reasoning";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/tool-group";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/src/ModelPicker";
import { useConversationInterrupts, parseSystemMessage } from "@/src/RuntimeProvider";
import { InlineRunStatus, ContextFillBar } from "@/src/RunStatusBar";
import { cn } from "@/lib/utils";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  useAuiState,
  useThreadViewportStore,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  MicIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentType,
  type FC,
  type PropsWithChildren,
} from "react";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`.
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

export const Thread: FC<ThreadProps> = ({ components = EMPTY_COMPONENTS }) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot isEmpty={isEmpty} />
    </ThreadComponentsContext.Provider>
  );
};

/** Keep the view pinned to the bottom as content grows — and land at the tail on
 *  a conversation SWITCH/LOAD.
 *
 *  Two problems this fixes, both rooted in assistant-ui's autoScroll giving up
 *  whenever it *thinks* the user scrolled up:
 *
 *   1. LAND AT TAIL: the runtime remounts per conversation and history streams in
 *      async (tail seed → full replay), so the library's one-shot initialize-scroll
 *      fires before layout and leaves the view at the top.
 *
 *   2. BIG-CHUNK BREAK (the reported bug): when a long message or a big tool result
 *      appends in one frame, scrollHeight jumps by more than the library's 1px
 *      bottom threshold while scrollTop is unchanged. Its scroll handler reads that
 *      as "not at bottom" (and, since scrollTop didn't DECREASE, not a user scroll-up
 *      either) and latches isAtBottom=false — so autoScroll disengages and you're
 *      stranded mid-scroll, forced to scroll down again.
 *
 *  Our own `stick` intent flag is the fix: it flips false ONLY on a genuine upward
 *  user gesture (scrollTop actually decreased), never on content growth. While stuck,
 *  a ResizeObserver (on every scroll-content child) + a MutationObserver (for newly
 *  mounted subtrees) re-pin to the bottom on any size change, chasing the growing
 *  bottom across a few frames of reflow — and restoring the store's isAtBottom so the
 *  library re-engages too. NB: this pairs with removing `scroll-smooth` from the
 *  viewport (see below) — instant pins don't fight a CSS scroll animation. */
function useStickToBottom() {
  const hasMessages = useAuiState((s) => s.thread.messages.length > 0);
  const store = useThreadViewportStore();

  useEffect(() => {
    if (!hasMessages) return;
    const el = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (!el) return;

    // Our intent flag — are we following the bottom? Starts true; only a real
    // upward user scroll turns it off; returning to the bottom turns it back on.
    let stick = true;
    let lastTop = el.scrollTop;
    // While set, ignore the scroll event our own re-pin triggers (so it can't
    // self-cancel `stick`).
    let pinning = 0;

    const atBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight <= 2;

    const syncStore = () => {
      try {
        store.getState().scrollToBottom?.({ behavior: "instant" });
      } catch {
        /* store shape varies across versions — the raw scrollTop below is the real fix */
      }
    };
    const pin = () => {
      pinning++;
      el.scrollTop = el.scrollHeight; // instant, synchronous — no smooth lag to fight
      syncStore(); // keep the library's isAtBottom true so ITS autoScroll stays on
      requestAnimationFrame(() => {
        pinning = Math.max(0, pinning - 1);
        lastTop = el.scrollTop;
      });
    };

    // Re-assert the pin until the bottom SETTLES. A big message/tool card keeps
    // growing for a few frames AFTER it mounts (markdown reflow, wrapping, image
    // load), so a single scrollTop set lands short — chase the growing bottom.
    //
    // A FIXED frame budget (we used 12) is racy: a big single-frame append under
    // load can keep reflowing past the budget, or slow rAF scheduling lets the
    // reflow outrun the chase, and the view is left stranded MANY viewports up until
    // some later event re-pins (the reported e2e flake — peak ~2200px on a 665px
    // viewport). So chase until we're genuinely at the bottom for a couple of
    // consecutive frames, not for a blind count. A high safety cap (~2s at 60fps)
    // bounds a pathological never-settling layout without reintroducing the strand.
    // Settle signal is scrollHeight STABILITY, not atBottom(): we pin() every frame,
    // so we're always at the bottom right after a pin — that tells us nothing about
    // whether the content is still reflowing. Instead keep chasing while scrollHeight
    // keeps changing (the append is still growing), and stop once it has held steady
    // for a few consecutive frames. A high safety cap (~2s @ 60fps) bounds a
    // pathological never-settling layout without reintroducing the strand.
    let chaseFrame: number | null = null;
    const CHASE_MAX_FRAMES = 120; // ~2s @ 60fps — a hard stop, not the common path
    const CHASE_STABLE_FRAMES = 3; // scrollHeight unchanged this many frames → settled
    const chase = () => {
      if (chaseFrame !== null) cancelAnimationFrame(chaseFrame);
      let frames = 0;
      let stableFrames = 0;
      let lastHeight = -1;
      const step = () => {
        if (!stick) { chaseFrame = null; return; }
        const h = el.scrollHeight;
        stableFrames = h === lastHeight ? stableFrames + 1 : 0;
        lastHeight = h;
        pin();
        // Stop only once the content has STOPPED growing (height stable) — so a big
        // single-frame append that reflows over many frames is chased the whole way,
        // never left stranded. The frame cap is just a runaway backstop.
        if (stableFrames >= CHASE_STABLE_FRAMES || ++frames >= CHASE_MAX_FRAMES) {
          chaseFrame = null;
          return;
        }
        chaseFrame = requestAnimationFrame(step);
      };
      chaseFrame = requestAnimationFrame(step);
    };

    const onScroll = () => {
      if (pinning > 0) return; // our own re-pin
      if (el.scrollTop < lastTop - 1) stick = false; // genuine scroll UP → stop following
      else if (atBottom()) stick = true; //             back at bottom → resume
      lastTop = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    // Follow content growth. A big message / tool card appends in one frame; a
    // ResizeObserver on the viewport's border-box does NOT see that (scrollHeight
    // isn't the border-box), so observe EVERY direct child of the scroll content —
    // the message group grows as children are added, and a re-pin fires immediately.
    // Re-observe on DOM mutations so newly-added subtrees are covered too.
    const ro = new ResizeObserver(() => {
      if (!stick) return;
      // Re-pin SYNCHRONOUSLY here, not only via the rAF chase. The ResizeObserver
      // callback runs with layout (before paint), so this follows the growth even
      // when rAF is starved — the residual flake was a severely stalled frame (a
      // normally-instant test taking 7s) where the rAF chase never got scheduled in
      // time and the view stranded ~3 viewports up. The chase() still runs for the
      // multi-frame reflow tail; this guarantees the first, biggest jump is caught.
      pin();
      chase();
    });
    const observeContent = () => {
      ro.disconnect();
      // The inner scroll content (holds the message group + footer).
      const inner = el.firstElementChild as HTMLElement | null;
      if (inner) {
        ro.observe(inner);
        for (const child of Array.from(inner.children)) ro.observe(child as HTMLElement);
      } else {
        ro.observe(el);
      }
    };
    observeContent();
    // New messages add/replace subtrees under the scroll content — re-attach the RO
    // so growth in a freshly-mounted message still triggers the follow.
    const mo = new MutationObserver(() => {
      observeContent();
      if (!stick) return;
      pin(); // synchronous follow (see the ResizeObserver note) + the chase tail
      chase();
    });
    mo.observe(el, { childList: true, subtree: true });

    // Land at the tail on first paint + chase the async history replay's late layout.
    chase();

    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      mo.disconnect();
      if (chaseFrame !== null) cancelAnimationFrame(chaseFrame);
    };
  }, [hasMessages, store]);
}

const ThreadRoot: FC<{ isEmpty: boolean }> = ({ isEmpty }) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);
  useStickToBottom();

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
      style={{
        // Widen the readable column — 44rem left a lot of empty space on wide
        // monitors. 64rem fills more of the available width while staying readable.
        ["--thread-max-width" as string]: "64rem",
        ["--composer-bg" as string]:
          "color-mix(in oklab, var(--color-muted) 30%, var(--color-background))",
        ["--composer-radius" as string]: "1.5rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        // Scroll-LOCK to the bottom by default: as the agent streams tokens / new
        // messages arrive, the view follows the latest content. turnAnchor="bottom"
        // flips assistant-ui's autoScroll on (it's OFF under the "top" anchor, which
        // pins the latest user turn to the top and does NOT follow streaming — the
        // "it doesn't stick to the bottom" bug). The lock releases automatically when
        // the user scrolls UP (isAtBottom goes false in the viewport store) and
        // re-engages when they click the scroll-to-bottom arrow (ThreadScrollToBottom
        // below, which fires scrollToBottom + restores isAtBottom).
        turnAnchor="bottom"
        autoScroll
        data-slot="aui_thread-viewport"
        // NO `scroll-smooth` here: useStickToBottom re-pins to the bottom on every
        // content-size change with an INSTANT scrollTop set. With CSS smooth-scroll on,
        // that set animates and interleaves with the library's own scroll animation —
        // the two fight and the view visibly thrashes (jumping up and down) before it
        // settles. Instant pinning is invisible + lands immediately. The manual
        // scroll-to-bottom arrow still animates: it passes behavior:"smooth" itself.
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll"
      >
        <div
          className={cn(
            // min-h-full (not flex-1): fill the viewport so the sticky footer's
            // mt-auto pins the composer to the bottom, WITHOUT flex-growing the
            // content — a flex-1 grow made the viewport scrollHeight drift so
            // assistant-ui's isAtBottom check missed by >1px and pinned it false,
            // which stopped streaming from following. min-h-full keeps
            // scrollHeight == real content height so sticky-to-bottom works.
            "mx-auto flex min-h-full w-full max-w-(--thread-max-width) flex-col px-4 pt-4",
            isEmpty && "justify-center",
          )}
        >
          <AuiIf condition={isNewChatView}>
            <Welcome />
          </AuiIf>

          <div
            data-slot="aui_message-group"
            className="mb-14 flex flex-col gap-y-6 empty:hidden"
          >
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-background flex flex-col gap-4 overflow-visible pb-4 md:pb-6",
              !isEmpty &&
                "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />
            {/* Inline run status — the thinking indicator (what the agent's doing +
                for how long) + Stop, right where the conversation is, following the
                scroll. Replaces the old detached bottom bar. */}
            <InlineRunStatus />
            {/* Context-window fill bar — how full the conversation's context is. */}
            <ContextFillBar />
            <ModelPicker />
            <Composer />
            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);
  // A spliced-in SYSTEM event (platform-injected: webhook, scheduler, background job,
  // broker) is carried as an assistant message with a `sys:` id + a marker text part.
  // Render it inline (chronological) as an auto-collapsed event chip, not a bubble.
  const sysId = useAuiState((s) => s.message.id);
  const sysText = useAuiState((s) => {
    const first = (s.message.content as Array<{ type?: string; text?: string }>)?.[0];
    return first?.type === "text" ? first.text : undefined;
  });
  const sys = parseSystemMessage(sysId, sysText);

  if (isEditing) return <EditComposer />;
  if (sys) return <SystemEventMessage source={sys.source} text={sys.text} />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessageComponent />;
};

/** A per-source glyph so the collapsed event line is scannable. */
function systemSourceIcon(source: string): string {
  switch (source) {
    case "slack": return "💬";
    case "github": return "🐙";
    case "gitlab": return "🦊";
    case "jira": return "📋";
    case "scheduler": return "⏰";
    case "background job": return "⚙️";
    case "broker": return "🔑";
    case "subagent": return "🤖";
    default: return "⚙️";
  }
}

/** A SYSTEM event rendered INLINE in the conversation at its chronological slot —
 *  auto-collapsed to a single de-emphasized line ("⚙️ system · <source> · <preview>")
 *  so it reads as a platform event, not a user turn. Click to expand the full body. */
const SystemEventMessage: FC<{ source: string; text: string }> = ({ source, text }) => {
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, " ").trim();
  const short = preview.length > 80 ? preview.slice(0, 80) + "…" : preview;

  return (
    <div
      data-slot="aui_system-message"
      data-source={source}
      className="mx-auto w-full max-w-(--thread-max-width) px-2"
    >
      <button
        type="button"
        data-testid="system-event-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-muted-foreground/70 hover:bg-muted/40 hover:text-muted-foreground"
      >
        <span aria-hidden className="shrink-0">{systemSourceIcon(source)}</span>
        <span className="shrink-0 font-medium capitalize">{source}</span>
        {!open && short && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground/60">{short}</span>
        )}
        <span aria-hidden className="ml-auto shrink-0 text-[10px] opacity-60">
          {open ? "▲" : "▼"}
        </span>
      </button>
      {open && (
        <div
          data-testid="system-event-body"
          className="mx-2 mb-1 whitespace-pre-wrap break-words border-l-2 border-border/60 pl-3 text-[12px] text-muted-foreground"
        >
          {text}
        </div>
      )}
    </div>
  );
};

const ThreadScrollToBottom: FC = () => {
  // The stock ScrollToBottom scrolls to the CURRENT scrollHeight, which in a long
  // conversation lands short of the true bottom: the last message / markdown / tool
  // cards are still laying out when the click fires, so scrollHeight grows AFTER the
  // scroll. Fix: after the built-in scroll (which also restores isAtBottom so
  // auto-follow re-engages), hard-scroll the real viewport element to its bottom
  // across the next few frames to catch that late layout — landing at the VERY end.
  const store = useThreadViewportStore();
  const onClick = () => {
    store.getState().scrollToBottom({ behavior: "smooth" });
    const el = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (!el) return;
    let n = 0;
    const settle = () => {
      el.scrollTop = el.scrollHeight; // jump to the true bottom as content settles
      if (++n < 6) requestAnimationFrame(settle); // re-assert over ~6 frames
    };
    requestAnimationFrame(settle);
  };
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        onClick={onClick}
        className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col items-center px-4 text-center">
      <h1 className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-semibold duration-200">
        How can I help you today?
      </h1>
    </div>
  );
};

const ThreadSuggestions: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-wrap items-center justify-center gap-2 px-4">
      <ThreadPrimitive.Suggestions>
        {() => <ThreadSuggestionItem />}
      </ThreadPrimitive.Suggestions>
    </div>
  );
};

const ThreadSuggestionItem: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-200">
      <SuggestionPrimitive.Trigger send asChild>
        <Button
          variant="ghost"
          className="aui-thread-welcome-suggestion text-foreground hover:bg-muted border-border/60 h-auto gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-normal whitespace-nowrap transition-colors"
        >
          <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1" />
          <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 empty:hidden" />
        </Button>
      </SuggestionPrimitive.Trigger>
    </div>
  );
};

const Composer: FC = () => {
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="aui_composer-shell"
          className="border-border/60 data-[dragging=true]:border-ring focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 flex w-full flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] focus-within:shadow-[0_6px_24px_-8px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.05)] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))] dark:shadow-none"
        >
          <ComposerAttachments />
          <ComposerPrimitive.Input
            placeholder="Send a message..."
            className="aui-composer-input placeholder:text-muted-foreground/80 max-h-32 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none"
            rows={1}
            autoFocus
            aria-label="Message input"
          />
          <ComposerAction />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC = () => {
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <ComposerAddAttachment />
      <div className="flex items-center gap-1.5">
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton
                tooltip="Voice input"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-dictate size-7 rounded-full"
                aria-label="Start voice input"
              >
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton
                tooltip="Stop dictation"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                aria-label="Stop voice input"
              >
                <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
              </TooltipIconButton>
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        {/* Send vs Stop is gated on OUR run state (useConversationInterrupts), NOT
            the runtime's thread.isRunning — the latter is ALWAYS false in the
            single-source model (the runtime never sees a real run), so the stock
            Cancel never appeared. ComposerSendOrStop shows Stop-in-the-composer
            while a goose run is in flight and wires it to our cancel(). */}
        <ComposerSendOrStop />
      </div>
    </div>
  );
};

const ComposerSendOrStop: FC = () => {
  const { isRunning, cancel } = useConversationInterrupts();
  if (isRunning) {
    return (
      <Button
        type="button"
        variant="default"
        size="icon"
        className="aui-composer-cancel size-7 rounded-full"
        aria-label="Stop generating"
        data-testid="composer-stop"
        onClick={() => void cancel()}
      >
        <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
      </Button>
    );
  }
  return (
    <ComposerPrimitive.Send asChild>
      <TooltipIconButton
        tooltip="Send message"
        side="bottom"
        type="button"
        variant="default"
        size="icon"
        className="aui-composer-send size-7 rounded-full"
        aria-label="Send message"
      >
        <ArrowUpIcon className="aui-composer-send-icon size-4.5" />
      </TooltipIconButton>
    </ComposerPrimitive.Send>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
  } = useContext(ThreadComponentsContext);

  // reserves space for action bar and compensates with `-mb` for consistent msg spacing
  // keeps hovered action bar from shifting layout (autohide doesn't support absolute positioning well)
  // for pt-[n] use -mb-[n + 6] & min-h-[n + 6] to preserve compensation
  const ACTION_BAR_PT = "pt-1.5";
  const ACTION_BAR_HEIGHT = `-mb-7.5 min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative duration-150"
    >
      <div
        data-slot="aui_assistant-message-content"
        // [contain-intrinsic-size:auto_24px] fixes issue #4104, don't change without checking for regressions
        className="text-foreground px-2 leading-relaxed wrap-break-word [contain-intrinsic-size:auto_24px] [content-visibility:auto]"
      >
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({
            reasoning: ["group-chainOfThought", "group-reasoning"],
            "tool-call": ["group-chainOfThought", "group-tool"],
            "standalone-tool-call": [],
          })}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-tool":
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>;
                }
                return (
                  <ToolGroupRoot variant="ghost">
                    <ToolGroupTrigger
                      count={part.indices.length}
                      active={part.status.type === "running"}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-reasoning": {
                if (ReasoningGroup) {
                  return (
                    <ReasoningGroup group={part}>{children}</ReasoningGroup>
                  );
                }
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot streaming={running}>
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case "data":
                return part.dataRendererUI;
              case "indicator":
                // Suppressed: the thinking status is shown ONCE, by the RunStatusBar's
                // pulsing dot (driven by the log-derived isRunning). This per-message
                // ● came from a DIFFERENT state source (the ag-ui base applier's run
                // tracking) and could disagree with the bar — so we don't render it.
                return null;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        {/* No BranchPicker: this UI renders SOLELY from the integrity log (a single
            timeline), so message "branches" (versions) aren't a real feature. The
            picker only ever surfaced a SPURIOUS "2/2" — the composer optimistically
            appends the user message, then our render pump's runtime.thread.reset()
            re-adds it from the log, which assistant-ui records as a 2nd branch.
            Hiding the picker removes the confusing artifact. */}
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="Refresh">
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="More"
            className="data-[state=open]:bg-accent"
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover/95 text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5 shadow-lg backdrop-blur-sm"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              Export as Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_60px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer bg-muted text-foreground rounded-xl px-4 py-2 wrap-break-word empty:hidden">
          <MessagePrimitive.Parts />
        </div>
        <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <UserActionBar />
        </div>
      </div>

      {/* No BranchPicker on the user message either — see the assistant-message
          note: the "2/2" was a spurious branch from the reset-vs-append collision,
          not a real message version. */}
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="Edit" className="aui-user-action-edit">
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root border-border/60 dark:border-muted-foreground/15 ms-auto flex w-full max-w-[85%] flex-col rounded-(--composer-radius) border bg-(--composer-bg) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] dark:shadow-none">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-full px-3.5"
            >
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 rounded-full px-3.5">
              Update
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
