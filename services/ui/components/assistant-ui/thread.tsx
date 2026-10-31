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
import { MessageTimestamp, useTimestampToggle } from "@/components/assistant-ui/message-timestamp";
import { SystemEventMessage } from "@/components/assistant-ui/system-event-message";
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
import { QueuedMessages } from "@/src/QueuedMessages";
import { useRenaming } from "@/src/sessions";
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
} from "@/icons";
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
 * Optional component overrides for the thread. `AssistantMessage` and `Welcome` replace
 * whole sections, and the remaining slots override how the assistant message renders tool
 * calls and part groups; tool UIs registered by name take precedence over `ToolFallback`.
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

/** Hoisted for a stable identity, since ThreadPrimitive.Messages memoizes on its children. */
const renderMessage = () => <ThreadMessage />;

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

// The startup loading placeholder counts as a new chat so the composer mounts centered.
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

/** Page older history in as the user scrolls toward the top, restoring scrollTop by the prepended growth so the content under the eye stays still. */
function useLoadOlderOnScroll() {
  const { hasOlderHistory, loadOlderHistory } = useConversationInterrupts();
  const hasMessages = useAuiState((s) => s.thread.messages.length > 0);

  useEffect(() => {
    if (!hasOlderHistory || !hasMessages) return;
    const el = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (!el) return;

    let loading = false;
    const TRIGGER_PX = 600; // start fetching before the seam is actually visible

    const maybeLoad = async () => {
      if (loading) return;
      if (el.scrollTop > TRIGGER_PX) return;
      // At the very bottom the user is following a live run.
      if (el.scrollHeight - el.scrollTop - el.clientHeight <= 2) return;
      loading = true;
      const before = el.scrollHeight;
      try {
        const added = await loadOlderHistory();
        if (added > 0) {
          // Two frames, because the height is only correct after React commits and layout runs.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const grew = el.scrollHeight - before;
              if (grew > 0) el.scrollTop += grew;
              loading = false;
            });
          });
          return;
        }
      } catch {
        /* a later scroll retries */
      }
      loading = false;
    };

    el.addEventListener("scroll", maybeLoad, { passive: true });
    void maybeLoad(); // the seam may already be in reach on first paint
    return () => el.removeEventListener("scroll", maybeLoad);
  }, [hasOlderHistory, loadOlderHistory, hasMessages]);
}

/**
 * Keep the view pinned to the bottom as content grows and land at the tail on a
 * conversation switch. A `stick` intent flag flips false only on a genuine upward user
 * scroll, never on content growth, which is where assistant-ui's own autoScroll gives
 * up; while stuck, a ResizeObserver and a MutationObserver re-pin on any size change.
 */
function useStickToBottom() {
  const hasMessages = useAuiState((s) => s.thread.messages.length > 0);
  const store = useThreadViewportStore();

  useEffect(() => {
    if (!hasMessages) return;
    const el = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (!el) return;

    // Whether we are following the bottom; only a real upward user scroll turns it off.
    let stick = true;
    let lastTop = el.scrollTop;
    // While set, the scroll event our own re-pin triggers is ignored.
    let pinning = 0;

    const atBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight <= 2;

    const syncStore = () => {
      try {
        store.getState().scrollToBottom?.({ behavior: "instant" });
      } catch {
        /* the store shape varies across versions; the raw scrollTop set is what matters */
      }
    };
    const pin = () => {
      pinning++;
      el.scrollTop = el.scrollHeight;
      syncStore(); // keep the library's isAtBottom true so its autoScroll stays on
      requestAnimationFrame(() => {
        pinning = Math.max(0, pinning - 1);
        lastTop = el.scrollTop;
      });
    };

    // Re-pin every frame until scrollHeight has held steady for a few frames, since a big message keeps reflowing after it mounts and pinning once lands short.
    let chaseFrame: number | null = null;
    const CHASE_MAX_FRAMES = 120; // a hard stop for a never-settling layout
    const CHASE_STABLE_FRAMES = 3; // scrollHeight unchanged this many frames means settled
    const chase = () => {
      // A running chase self-extends, so it is not restarted.
      if (chaseFrame !== null) return;
      let frames = 0;
      let stableFrames = 0;
      let lastHeight = -1;
      const step = () => {
        if (!stick) { chaseFrame = null; return; }
        const h = el.scrollHeight;
        stableFrames = h === lastHeight ? stableFrames + 1 : 0;
        lastHeight = h;
        pin();
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
      if (el.scrollTop < lastTop - 1) stick = false; // a genuine scroll up stops following
      else if (atBottom()) stick = true; // back at the bottom resumes it
      lastTop = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    // The viewport's border-box does not change with scrollHeight, so every direct child of the scroll content is observed instead.
    const ro = new ResizeObserver(() => {
      if (!stick) return;
      // The synchronous pin runs with layout, so the first jump is caught even when rAF is starved.
      pin();
      chase();
    });
    const observeContent = () => {
      ro.disconnect();
      // The inner scroll content holds the message group and footer.
      const inner = el.firstElementChild as HTMLElement | null;
      if (inner) {
        ro.observe(inner);
        for (const child of Array.from(inner.children)) ro.observe(child as HTMLElement);
      } else {
        ro.observe(el);
      }
    };
    observeContent();
    // Re-attach the ResizeObserver when new messages mount so their growth is followed too.
    const mo = new MutationObserver(() => {
      observeContent();
      if (!stick) return;
      pin();
      chase();
    });
    // Observing the whole subtree janks, so only new-message mounts are observed.
    const messageGroup = el.querySelector<HTMLElement>(
      '[data-slot="aui_message-group"]',
    );
    if (messageGroup) {
      mo.observe(messageGroup, { childList: true, subtree: false });
    } else {
      mo.observe(el, { childList: true, subtree: true }); // the group is not mounted yet
    }

    // Land at the tail on first paint and chase the history replay's late layout.
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
  useLoadOlderOnScroll();

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-chat @container flex h-full flex-col"
      style={{
        // The composer and messages both track this width.
        ["--thread-max-width" as string]: "78rem",
        // A raised card surface so the composer reads as a distinct input on the chat background.
        ["--composer-bg" as string]: "var(--color-card)",
        ["--composer-radius" as string]: "1.5rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        // The "bottom" anchor turns assistant-ui's autoScroll on, so the view follows streaming until the user scrolls up.
        turnAnchor="bottom"
        autoScroll
        data-slot="aui_thread-viewport"
        // No `scroll-smooth`, because useStickToBottom's instant pins would fight a CSS scroll animation.
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll"
      >
        <div
          className={cn(
            // min-h-full keeps scrollHeight equal to the real content height, which assistant-ui's isAtBottom check depends on.
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
            <ThreadPrimitive.Messages>{renderMessage}</ThreadPrimitive.Messages>
            {/* Messages sent mid-run, shown faded at the tail until the agent picks them up. */}
            <QueuedMessages />
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              // The sticky footer must match the chat surface and stay opaque over the messages scrolling under it.
              "aui-thread-viewport-footer bg-chat flex flex-col gap-4 overflow-visible pb-4 md:pb-6",
              !isEmpty &&
                "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />
            <InlineRunStatus />
            <ContextFillBar />
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
  // A spliced-in system event arrives as an assistant message with a `sys:` id and a marker text part.
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


const ThreadScrollToBottom: FC = () => {
  // The stock scroll lands short while the last message is still laying out, so re-assert the bottom over the next few frames.
  const store = useThreadViewportStore();
  const onClick = () => {
    store.getState().scrollToBottom({ behavior: "smooth" });
    const el = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (!el) return;
    let n = 0;
    const settle = () => {
      el.scrollTop = el.scrollHeight;
      if (++n < 6) requestAnimationFrame(settle);
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
  // The composer grabs focus when a run starts and when the thread auto-scrolls to new output;
  // during an inline rename that blur commits the half-typed title, so it holds off until done.
  const renaming = useRenaming();
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="aui_composer-shell"
          // The composer is a control, so its boundary needs the 3:1 contrast of border-input.
          className="border-input data-[dragging=true]:border-ring focus-within:border-ring dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 flex w-full flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] focus-within:shadow-[0_6px_24px_-8px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.05)] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))] dark:shadow-none"
        >
          <ComposerAttachments />
          <ComposerPrimitive.Input
            placeholder="Send a message..."
            className="aui-composer-input placeholder:text-muted-foreground max-h-32 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none"
            rows={1}
            autoFocus
            unstable_focusOnRunStart={!renaming}
            unstable_focusOnScrollToBottom={!renaming}
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
      {/* Attach and the model selector. */}
      <div className="flex items-center gap-1">
        <ComposerAddAttachment />
        <ModelPicker />
      </div>
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
        {/* Send vs Stop is gated on the log-derived run state, since the runtime's thread.isRunning never sees a real run. */}
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
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm">
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

  // Reserve space for the action bar and compensate with `-mb` (for pt-[n] use -mb-[n + 6] and min-h-[n + 6]) so hovering it does not shift the layout.
  const ACTION_BAR_PT = "pt-1.5";
  const ACTION_BAR_HEIGHT = `-mb-7.5 min-h-7.5 ${ACTION_BAR_PT}`;
  const timestamp = useTimestampToggle();

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      onClick={timestamp.onClick}
      className="fade-in slide-in-from-bottom-1 animate-in relative duration-150"
    >
      <div
        data-slot="aui_assistant-message-content"
        // The contain-intrinsic-size value is load-bearing for layout; check for regressions before changing it.
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
                // The thinking status is shown once by the run status bar from the log-derived run state.
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
        {/* No BranchPicker, because the UI renders from a single log timeline and branches are not a real feature. */}
        <AssistantActionBar />
        {/* In the reserved footer row, so showing it does not shift the layout. */}
        <MessageTimestamp shown={timestamp.shown} className="ms-1" />
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
  const timestamp = useTimestampToggle();
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      onClick={timestamp.onClick}
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_60px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer bg-muted text-foreground rounded-xl px-4 py-2 text-[15px] desk:text-base wrap-break-word empty:hidden">
          <MessagePrimitive.Parts />
        </div>
        <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <UserActionBar />
        </div>
      </div>
      <MessageTimestamp shown={timestamp.shown} className="col-start-2 -mt-1 justify-self-end px-1" />
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
      <ComposerPrimitive.Root className="aui-edit-composer-root border-input dark:border-muted-foreground/15 ms-auto flex w-full max-w-[85%] flex-col rounded-(--composer-radius) border bg-(--composer-bg) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] dark:shadow-none">
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
