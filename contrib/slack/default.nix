{
  contribs.slack = {
    src = ./.;
    services.broker.enable = true;
    services.webhooks.enable = true;
    # Not "how to use Slack" — how to FORMAT for it (mrkdwn, not Markdown).
    skills."slack-formatting.md" = ./skills/slack-formatting.md;
  };
}
