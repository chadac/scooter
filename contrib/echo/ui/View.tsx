// The echo contrib's view: the fixture for `ui.views`. It lists conversations from the
// live store and opens one in a ChatPanel beside them, so a failure here is about loading,
// routing or the SDK, not the view.
import { Button, ChatPanel, openConversation, useConversations, useOpenConversation, useViewRoute } from "@/src/contrib/sdk";

export default function EchoView() {
  const { path } = useViewRoute();
  const conversations = useConversations();
  const open = useOpenConversation();
  return (
    <div className="flex h-full min-h-0" data-testid="echo-view">
      <ul className="w-64 shrink-0 space-y-1 overflow-y-auto border-e p-2">
        <li className="px-2 text-xs text-muted-foreground" data-testid="echo-view-path">
          /echo/{path}
        </li>
        {conversations.map((c) => (
          <li key={c.id}>
            <Button
              variant={c.id === open ? "secondary" : "ghost"}
              size="sm"
              className="w-full justify-start truncate"
              data-testid="echo-view-row"
              onClick={() => openConversation(c.id)}
            >
              {c.title}
            </Button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 flex-1">{open && <ChatPanel conversationId={open} />}</div>
    </div>
  );
}
