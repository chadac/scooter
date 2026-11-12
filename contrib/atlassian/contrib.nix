# What atlassian is; its deployment half is ./deployment.nix. It also enables and
# configures contribs.jira, which keeps Jira's tools, webhooks and links.
{ lib, config, ... }:
let
  inherit (lib) mkOption types;
  atl = config.contribs.atlassian;
  creds = lib.optionalAttrs (atl.credentialsSecret != null) {
    ATLASSIAN_CLIENT_ID = { inherit (atl.credentialsSecret) name; key = atl.credentialsSecret.clientIdKey; };
    ATLASSIAN_CLIENT_SECRET = { inherit (atl.credentialsSecret) name; key = atl.credentialsSecret.clientSecretKey; };
  } // lib.optionalAttrs (atl.cloudId != "") { ATLASSIAN_CLOUD_ID = atl.cloudId; };
in
{
  contribs.atlassian = { config, ... }: {
    options.credentialsSecret = mkOption {
      default = null;
      example = { name = "atlassian-oauth"; };
      description = ''
        Secret in the broker namespace holding the Atlassian OAuth app's client
        id and secret (a service account's client-credentials app). One app
        serves every product: give it the Jira and Confluence scopes the agent
        may use, since those scopes are the upper limit on what it can do. Null
        leaves the integration configured but inert.
      '';
      type = types.nullOr (types.submodule {
        options = {
          name = mkOption { type = types.str; description = "Secret name."; };
          clientIdKey = mkOption { type = types.str; default = "ATLASSIAN_CLIENT_ID"; description = "Key holding the client id."; };
          clientSecretKey = mkOption { type = types.str; default = "ATLASSIAN_CLIENT_SECRET"; description = "Key holding the client secret."; };
        };
      });
    };

    options.cloudId = mkOption {
      type = types.str;
      default = "";
      example = "1324a887-45db-1bf4-1e99-ef0ff456d421";
      description = ''
        The site's cloud id, from `https://<site>.atlassian.net/_edge/tenant_info`.
        Only `api.atlassian.com/ex/<product>/<cloudId>/` paths get the token.
      '';
    };

    options.siteUrl = mkOption {
      type = types.str;
      default = "";
      example = "https://acme.atlassian.net";
      description = ''
        The site root. When set, the forge proxy also intercepts this host and
        rewrites `/rest/…` (Jira) and `/wiki/…` (Confluence) onto the
        `api.atlassian.com` paths, so links copied from the browser work in the
        sandbox. Also builds the human /browse/{KEY} link for issues the agent
        creates. Other paths on the site are forwarded with no token.
      '';
    };

    options.forgePolicy = mkOption {
      type = types.str;
      default = "";
      example = "my_scooter_policies.atlassian:policy";
      description = ''
        A `module:attr` naming a ForgePolicy (scooter_broker_lib.forge) the broker
        checks on every proxied Atlassian request before injecting the token. It
        sees the canonical `api.atlassian.com` path, so the product is in
        `path`. Empty allows everything the app's scopes allow.
      '';
    };

    options.jira = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = ''
          Proxy Jira (`/ex/jira/<cloudId>/`) and ship Jira's agent tools, issue
          links and UI (contribs.jira).
        '';
      };
      webhooksEnabled = mkOption {
        type = types.bool;
        default = false;
        description = "Serve /webhooks/jira; needs JIRA_WEBHOOK_SECRET in the webhooks Secret.";
      };
    };

    options.confluence.enable = mkOption {
      type = types.bool;
      default = true;
      description = "Proxy Confluence (`/ex/confluence/<cloudId>/`).";
    };

    config = {
      src = ./.;
      services.broker = {
        enable = true;
        env = creds // {
          ATLASSIAN_PRODUCTS = lib.concatStringsSep " "
            (lib.optional config.jira.enable "jira" ++ lib.optional config.confluence.enable "confluence");
          ATLASSIAN_SITE_URL = lib.mkIf (config.siteUrl != "") config.siteUrl;
          ATLASSIAN_FORGE_POLICY = lib.mkIf (config.forgePolicy != "") config.forgePolicy;
        };
      };
      skills."scooter-atlassian.md" = ./skills/scooter-atlassian.md;
    };
  };

  # Jira's webhooks need this client; the broker env already has it.
  # mkIf per field: element-level mkIf recurses through attrsOf.
  contribs.jira = lib.mapAttrs (_: lib.mkIf (atl.enable && atl.jira.enable)) {
    enable = true;
    fromAtlassian = true;
    siteUrl = atl.siteUrl;
    webhooksEnabled = atl.jira.webhooksEnabled;
    services.webhooks.env = creds;
  };
}
