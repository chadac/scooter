/**
 * Conversation UI — session sidebar + the styled assistant-ui Thread, driven by
 * the agent-host's AG-UI stream. Messages, tool calls, and reasoning stream in
 * live as the agent works in the sandbox.
 */

import { RuntimeProvider } from "./RuntimeProvider.js";
import { Sidebar } from "./Sidebar.js";
import { InterruptPanel } from "./InterruptPanel.js";
import { UserBadge } from "./UserBadge.js";
import { Thread } from "@/components/assistant-ui/thread";

export function App() {
  return (
    <RuntimeProvider>
      <div className="flex h-dvh flex-col">
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3 text-sm">
          <div>
            <strong>Scooter</strong>
            <span className="text-muted-foreground"> — your agent, running in a Nix sandbox</span>
          </div>
          {/* Signed-in user (from the ingress identity); hidden when anonymous. */}
          <UserBadge />
        </header>
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1">
              <Thread />
            </div>
            {/* Agent option/permission requests (AG-UI interrupts) appear here as
                inline buttons, between the thread and the composer. */}
            <InterruptPanel />
          </main>
        </div>
      </div>
    </RuntimeProvider>
  );
}
