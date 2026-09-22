{
  contribs.jira = {
    src = ./.;
    services.broker.enable = true;
    services.webhooks.enable = true;

    # The UI row that used to be hardcoded in ui/src/{sourceIcon.tsx,
    # toolCallView.ts,sessions.ts}: a deployment without this contrib now has no
    # Jira chip, icon or card, instead of a dead one. Why: PR #601.
    ui = {
      source = { label = "Jira"; icon = ./icon.svg; color = "#0052CC"; linkProvider = true; };
      tools.jira_comment = {
        argKey = "body";
        action = "commented on Jira";
        titles = [ "Comment on the Jira issue" ];
      };
    };
  };
}
