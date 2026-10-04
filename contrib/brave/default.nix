{
  contribs.brave = {
    src = ./.;
    services.broker.enable = true;

    # No `ui`: `web_search` renders as a plain tool call, not a provider card — the UI
    # deliberately returns null for it (ui/src/toolCallView.test.ts), and brave is not
    # a linked-resource source, so it contributes no chip or icon either.
    #
    # No `skills` either, and that is a judgement rather than an omission: what the
    # agent needs to know about searching is the same whichever provider is wired, so
    # it stays one bullet in skills/agent-tools.md. A per-contrib skill would also
    # collide with kagi's over the same filename while saying the same thing.
  };
}
