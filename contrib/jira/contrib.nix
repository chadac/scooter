{ lib, ... }:
{
  contribs.jira = {
    options.siteUrl = lib.mkOption {
      type = lib.types.str;
      default = "";
      example = "https://acme.atlassian.net";
      description = ''
        The Jira SITE base URL, used to build a human /browse/{KEY} link when the
        broker auto-links an issue an agent creates via the Jira proxy (the
        create-issue API response carries no human URL). Empty -> auto-link uses
        the API `self` URL instead.
      '';
    };

    config = {
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
  };
}
