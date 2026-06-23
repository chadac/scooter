/**
 * Conversation UI — the styled assistant-ui Thread driven by the agent-host's
 * AG-UI stream. Messages, tool calls, and reasoning stream in live as Goose
 * works in the sandbox.
 */

import { RuntimeProvider } from "./RuntimeProvider.js";
import { Thread } from "@/components/assistant-ui/thread";

export function App() {
  return (
    <RuntimeProvider>
      <div className="flex h-dvh flex-col">
        <header className="border-b px-4 py-3 text-sm">
          <strong>kubenix-agent-sandbox</strong>
          <span className="text-muted-foreground"> — agent runs in a Nix sandbox</span>
        </header>
        <main className="min-h-0 flex-1">
          <Thread />
        </main>
      </div>
    </RuntimeProvider>
  );
}
