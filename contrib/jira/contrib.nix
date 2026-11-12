# Jira's tools, webhooks, issue links and UI. Configured through
# contribs.atlassian.jira (contrib/atlassian), which owns the OAuth client and
# the forge proxy; nothing here is set by a deployment directly.
{ lib, ... }:
{
  contribs.jira = { config, ... }: {
    options.fromAtlassian = lib.mkOption {
      type = lib.types.bool;
      default = false;
      internal = true;
      description = "Set by contribs.atlassian when it enables this contrib.";
    };

    options.siteUrl = lib.mkOption {
      type = lib.types.str;
      default = "";
      internal = true;
      description = "From contribs.atlassian.siteUrl: builds the human /browse/{KEY} link.";
    };

    options.webhooksEnabled = lib.mkOption {
      type = lib.types.bool;
      default = false;
      internal = true;
      description = "From contribs.atlassian.jira.webhooksEnabled.";
    };

    config = {
      src = ./.;
      links.typeAliases = lib.importJSON ./scooter_contrib_jira/link_type_aliases.json;
      services.broker = {
        # A throw, since kubenix has no `assertions` option.
        enable = config.fromAtlassian || throw ''
          contribs.jira is configured through contribs.atlassian now, which also
          holds the OAuth client Jira used to read from extraEnv:

            contribs.atlassian = {
              enable = true;
              credentialsSecret.name = "atlassian-oauth";  # ATLASSIAN_CLIENT_ID / _SECRET
              cloudId = "…";
              siteUrl = "https://acme.atlassian.net";      # was contribs.jira.siteUrl
              jira.webhooksEnabled = true;                 # was contribs.jira.webhooksEnabled
            };

          and drop contribs.jira.* (jira.enable defaults true under atlassian).
        '';
        env.JIRA_SITE_URL = lib.mkIf (config.siteUrl != "") config.siteUrl;
      };
      services.webhooks = {
        enable = true;
        env.JIRA_ENABLED = lib.boolToString config.webhooksEnabled;
      };

      # The UI row: the Jira chip, icon and card.
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
