{ lib, ... }:
let
  clib = import ../lib.nix { inherit lib; };
in
{
  contribs.github = { config, ... }: {
    options = {
      appId = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "GitHub App ID (GITHUB_APP_ID).";
      };

      installationId = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = ''
          GitHub App installation ID (GITHUB_APP_INSTALLATION_ID). With `owners` empty,
          every agent token comes from this installation. With `owners` set, it is the
          fallback for requests that name no listed account, and may be left empty to
          use the first owner's installation.
        '';
      };

      owners = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "my-user" "my-org" ];
        description = ''
          The GitHub accounts (users or orgs) this App serves. When set, the broker
          gives each request a token from the App's installation on the account the
          request names (its repo path, or `gh`'s GraphQL `owner`), and webhooks drop
          events from any other account. Installations on unlisted accounts are never
          used, so this is required before making the App public.
        '';
      };

      host = lib.mkOption {
        type = lib.types.str;
        default = "github.com";
        example = "github.example.com";
        description = ''
          The GitHub host: `github.com`, or a GitHub Enterprise Server hostname. The
          broker's forge proxy, http-proxy and App token minting, the webhooks' API
          calls, and `gh` in the sandbox all target it.
        '';
      };

      forgePolicy = lib.mkOption {
        type = lib.types.str;
        default = "";
        example = "my_scooter_policies.github:policy";
        description = ''
          A `module:attr` naming a ForgePolicy (scooter_broker_lib.forge) the broker
          checks on every GitHub request it makes for an agent: git push/fetch through
          the forge proxy, `gh`, the http-proxy and the agent tools. The module must be
          importable by the broker. Empty (the default) allows everything the App allows.
        '';
      };

      webhooksEnabled = lib.mkOption {
        type = lib.types.bool;
        default = config.enable;
        defaultText = lib.literalExpression "config.contribs.github.enable";
        description = "Enable webhooks.";
      };

      userAuth = {
        enable = lib.mkEnableOption ''
          acting as the user on GitHub in their private conversations. Each user links
          their account on Settings → GitHub, through the App's user authorization
          (OAuth) or a fine-grained PAT. In the App's settings, turn on "Expire user
          authorization tokens" and set the callback URL to
          `https://<ingress host>/contrib-api/github/callback`. To have Scooter add each
          user's SSH key to their account, grant the "Git SSH keys" account permission
        '';

        clientId = lib.mkOption {
          type = lib.types.str;
          default = "";
          example = "Iv23liAbCdEf";
          description = "The GitHub App's client ID. Empty leaves only the PAT option.";
        };

        clientSecretSecret = clib.mkSecretOption {
          key = "client-secret";
          holds = "the GitHub App client secret";
          nullable = true;
          description = "Secret holding the GitHub App's client secret, in the broker namespace.";
        };
      };

      privateKeySecret = clib.mkSecretOption {
        key = "private-key";
        holds = "the PEM";
        description = ''
          Secret holding the GitHub App private key (PEM). The secret must exist in
          the broker namespace.

          Enabling this contrib enables the GitHub provider, backed by a GitHub App:
          it vends installation tokens for git/HTTPS and the API.
        '';
      };
    };

    config = {
      src = ./.;
      links.typeAliases = lib.importJSON ./scooter_contrib_github/link_type_aliases.json;
      sandbox.module = ./sandbox.nix;
      # The tool card the UI renders for github_comment.
      ui.tools.github_comment = { argKey = "body"; action = "commented on GitHub"; };

      # pyjwt+cryptography sign the RS256 App JWT that both halves mint.
      # Its own database (contrib_github) for linked user accounts.
      db = lib.mkIf config.userAuth.enable {
        enable = true;
        tables.github_user_tokens = { };
      };

      ui.settingsTabs = lib.mkIf config.userAuth.enable [{
        label = "GitHub";
        order = 55;
        entry = "ui/SettingsTab.tsx";
        api = true;
      }];

      services.broker = {
        enable = true;
        pythonDeps = ps: [ ps.pyjwt ps.cryptography ps.aiosqlite ];
        env = {
          GITHUB_USER_AUTH_ENABLED = lib.boolToString config.userAuth.enable;
          GITHUB_APP_CLIENT_ID = lib.mkIf (config.userAuth.clientId != "") config.userAuth.clientId;
          GITHUB_APP_CLIENT_SECRET = lib.mkIf (config.userAuth.clientSecretSecret != null) config.userAuth.clientSecretSecret;
          GITHUB_HOST = config.host;
          GITHUB_APP_ID = config.appId;
          # Empty would fail the broker's int parse.
          GITHUB_APP_INSTALLATION_ID = lib.mkIf (config.installationId != "") config.installationId;
          GITHUB_APP_OWNERS = lib.concatStringsSep "," config.owners;
          GITHUB_APP_PRIVATE_KEY = config.privateKeySecret;
          GITHUB_FORGE_POLICY = lib.mkIf (config.forgePolicy != "") config.forgePolicy;
        };
      };
      services.webhooks = {
        enable = true;
        pythonDeps = ps: [ ps.pyjwt ps.cryptography ];
        # The same App identifies the agent's own comments.
        env = {
          GITHUB_HOST = config.host;
          GITHUB_ENABLED = lib.boolToString config.webhooksEnabled;
          GITHUB_APP_ID = config.appId;
          GITHUB_APP_OWNERS = lib.concatStringsSep "," config.owners;
          GITHUB_APP_PRIVATE_KEY = config.privateKeySecret;
        };
      };
    };
  };
}
