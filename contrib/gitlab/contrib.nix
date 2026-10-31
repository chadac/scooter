{ lib, ... }:
let
  clib = import ../lib.nix { inherit lib; };
in
{
  contribs.gitlab = { config, ... }: {
    options.host = lib.mkOption {
      type = lib.types.str;
      default = "gitlab.com";
      example = "gitlab.example.com";
      description = ''
        The GitLab host: `gitlab.com`, or a self-hosted GitLab's hostname. The broker's
        forge proxy and http-proxy, the webhooks' API calls, and `glab` in the sandbox
        all target it.
      '';
    };

    options.forgePolicy = lib.mkOption {
      type = lib.types.str;
      default = "";
      example = "my_scooter_policies.gitlab:policy";
      description = ''
        A `module:attr` naming a ForgePolicy (scooter_broker_lib.forge) the broker
        checks on every GitLab request it makes for an agent: git push/fetch through
        the forge proxy, `glab`, the http-proxy and the agent tools. The module must be
        importable by the broker. Empty (the default) allows everything the token allows.
      '';
    };

    options.webhooksEnabled = lib.mkOption {
      type = lib.types.bool;
      default = config.enable;
      defaultText = lib.literalExpression "config.contribs.gitlab.enable";
      description = "Enable webhooks.";
    };

    options.userAuth = {
      enable = lib.mkEnableOption ''
        acting as the user on GitLab in their private conversations. Each user links
        their account on Settings → GitLab, through an OAuth application (scope `api`)
        or a personal access token. Register the application with the redirect URI
        `https://<ingress host>/contrib-api/gitlab/callback`
      '';

      clientId = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "The GitLab OAuth application's ID. Empty leaves only the PAT option.";
      };

      clientSecretSecret = clib.mkSecretOption {
        key = "client-secret";
        holds = "the GitLab OAuth application secret";
        nullable = true;
        description = "Secret holding the GitLab OAuth application's secret, in the broker namespace.";
      };
    };

    options.tokenSecret = clib.mkSecretOption {
      key = "GITLAB_TOKEN";
      holds = "the GitLab token";
      description = ''
        Secret holding the GitLab token (glpat-…). Injected as GITLAB_TOKEN. The
        secret must exist in the broker namespace.

        Enabling this contrib enables the GitLab provider: a transparent
        http-proxy to gitlab.com with the token injected.
      '';
    };

    config = {
      src = ./.;
      links.typeAliases = lib.importJSON ./scooter_contrib_gitlab/link_type_aliases.json;
      sandbox.module = ./sandbox.nix;

      # The UI row: the GitLab chip, icon and card.
      ui = {
        source = { label = "GitLab"; icon = ./icon.svg; color = "#FC6D26"; linkProvider = true; };
        settingsTabs = lib.mkIf config.userAuth.enable [{
          label = "GitLab";
          order = 56;
          entry = "ui/SettingsTab.tsx";
          api = true;
        }];
        tools.gitlab_comment = {
          argKey = "body";
          action = "commented on GitLab";
          titles = [ "Comment on the GitLab MR" ];
        };
      };

      # Its own database (contrib_gitlab) for linked user accounts.
      db = lib.mkIf config.userAuth.enable {
        enable = true;
        tables.gitlab_user_tokens = { };
      };

      services.broker = {
        enable = true;
        pythonDeps = ps: [ ps.aiosqlite ];
        env = {
          GITLAB_USER_AUTH_ENABLED = lib.boolToString config.userAuth.enable;
          GITLAB_OAUTH_CLIENT_ID = lib.mkIf (config.userAuth.clientId != "") config.userAuth.clientId;
          GITLAB_OAUTH_CLIENT_SECRET = lib.mkIf (config.userAuth.clientSecretSecret != null) config.userAuth.clientSecretSecret;
          GITLAB_HOST = config.host;
          GITLAB_TOKEN = config.tokenSecret;
          GITLAB_FORGE_POLICY = lib.mkIf (config.forgePolicy != "") config.forgePolicy;
        };
      };
      services.webhooks = {
        enable = true;
        env = {
          GITLAB_HOST = config.host;
          GITLAB_ENABLED = lib.boolToString config.webhooksEnabled;
        };
        # Only this half reads Jira keys, and the grammar is jira's.
        pythonDeps = ps: [ ps.scooterContrib.jira ];
      };
    };
  };
}
