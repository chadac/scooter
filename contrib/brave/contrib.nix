# brave DECLARED: what this contrib IS. Its deployment options are in
# ./platform.nix — a different eval, which is why it is a different file
# (contrib/README.md).
{
  contribs.brave = {
    src = ./.;
    services.broker.enable = true;

    # No `ui`: `brave_web_search` renders as a plain tool call, not a provider card —
    # the UI deliberately returns null for it (ui/src/toolCallView.test.ts), and brave
    # is not a linked-resource source, so it contributes no chip or icon either.
    #
    # No `skills` either, and that is a judgement rather than an omission: what the
    # agent needs to know about searching is the same whichever providers are wired, so
    # it stays one bullet in skills/agent-tools.md — including the rule for when
    # SEVERAL search tools are listed, which no single contrib could state. What is
    # specific to brave (an independent crawl) belongs in the tool's own docstring,
    # which is what the agent reads when choosing between two of them.
  };
}
