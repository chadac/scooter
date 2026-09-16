# Webhooks — Deployment + Service + (optional) Ingress.
#
# Receives provider webhooks (GitHub/GitLab/Jira/Slack) and spawns agent
# conversations via the agent-host /agui. Must be publicly reachable for
# providers to call it → a Traefik ingress (gated; in-cluster tests don't need
# it). Providers authenticate by SIGNATURE (HMAC), so the ingress is
# deliberately UNAUTHENTICATED — do NOT attach a basic-auth middleware or
# GitHub/Slack deliveries would be rejected before signature checks run.
# See docs/WEBHOOKS.md + services/webhooks/.

{ config, lib, ... }:

let
  cfg = config.agentSandbox;
  wcfg = cfg.webhooks;
in
{
  options.agentSandbox.webhooks = with lib; {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Deploy the webhooks service.";
    };
    image = mkOption {
      type = types.str;
      default = "${cfg.registryPrefix}agent-webhooks:latest";
      defaultText = literalExpression ''"''${registryPrefix}agent-webhooks:latest"'';
      description = "OCI ref of the webhooks image.";
    };
    testWebhook = mkOption {
      type = types.bool;
      default = false;
      description = "Enable /webhooks/test for the spawn-from-webhook e2e.";
    };

    # --- Provider enablement ------------------------------------------------
    githubEnabled = mkOption {
      type = types.bool;
      default = false;
      description = "Enable the GitHub webhook handler (/webhooks/github).";
    };
    gitlabEnabled = mkOption {
      type = types.bool;
      default = false;
      description = "Enable the GitLab webhook handler (/webhooks/gitlab).";
    };
    slackEnabled = mkOption {
      type = types.bool;
      default = false;
      description = "Enable the Slack events handler (/webhooks/slack).";
    };

    # --- Trigger convention -------------------------------------------------
    mentionPattern = mkOption {
      type = types.str;
      default = "@agent";
      description = ''
        Text the agent looks for to treat a comment/message as a request.
        GitHub @<name> does not autocomplete for non-users, so a sigil like
        "!scooter" reads better there; Slack uses its native app_mention event
        regardless of this string.
      '';
    };
    labelTrigger = mkOption {
      type = types.str;
      default = "scooter";
      description = "Issue/PR label name that triggers a conversation (GitHub/GitLab).";
    };
    ignoreUsernames = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "scooter-acme[bot]" "dependabot[bot]" ];
      description = ''
        Comment/review authors to drop outright (IGNORE_USERNAMES), matched
        case-insensitively — e.g. a noisy third-party bot. GitHub recognizes the
        agent's own comments from the App identity (githubApp below), so this is
        for OTHER authors; GitLab payloads carry no bot flag at all, so it is the
        only lever there.
      '';
    };
    ignoreBotAuthors = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Fallback for deployments with no githubApp credentials: drop GitHub
        comments/reviews authored by any Bot account unless they mention the
        agent. With githubApp set the agent's own comments are recognized by
        login and this only affects OTHER bots. Disable if you rely on a bot
        relaying human content without a mention.
      '';
    };
    # The agent comments through the BROKER's GitHub App; the same App backs this
    # service, so `GET /app` here names the author to filter (see handlers/
    # github.py `_is_self_authored`). Point this at the broker's key Secret —
    # agentSandbox.broker.githubApp.privateKeySecret, same namespace.
    githubApp = {
      appId = mkOption {
        type = types.str;
        default = "";
        description = "GitHub App ID (GITHUB_APP_ID). Same App as the broker's.";
      };
      privateKeySecret = mkOption {
        type = types.nullOr (types.submodule {
          options = {
            name = mkOption { type = types.str; description = "Secret name (same namespace)."; };
            key = mkOption { type = types.str; default = "private-key"; description = "Secret key holding the PEM."; };
          };
        });
        default = null;
        example = { name = "github-app-key"; key = "private-key"; };
        description = ''
          Secret holding the GitHub App private key (PEM), mounted as
          GITHUB_APP_PRIVATE_KEY. Null -> no App identity: webhooks falls back to
          ignoreBotAuthors, and posts comments with the GITHUB_TOKEN PAT.
        '';
      };
    };
    logLevel = mkOption {
      type = types.str;
      default = "INFO";
      example = "DEBUG";
      description = "Root log level (LOG_LEVEL) — DEBUG for verbose tracing.";
    };

    # The public UI base URL, so a webhook-created conversation's "View
    # conversation" link (posted back to Slack/GitHub/GitLab/Jira) is a real,
    # directly-visitable deep-link (<managerUrl>/?thread=<id>). Defaults to
    # https://<chat ingress.host> WHENEVER the host is set — NOT gated on
    # ingress.enable: the host IS the public URL even when scooter doesn't render its
    # own Ingress (e.g. an oauth2-proxy reverse-proxy fronts the host instead). Gating
    # on ingress.enable left AGENT_MANAGER_URL empty in exactly that setup, so the
    # Slack/GitHub link degraded to a bare conversation id. Override for a different UI
    # hostname; empty (no host) -> the link degrades to the raw id.
    managerUrl = mkOption {
      type = types.str;
      default = if cfg.ingress.host != "" then "https://${cfg.ingress.host}" else "";
      defaultText = lib.literalExpression ''"https://''${agentSandbox.ingress.host}" (when the chat host is set)'';
      description = "Public UI base URL for the 'View conversation' deep-links (AGENT_MANAGER_URL).";
    };

    # --- Provider secrets ---------------------------------------------------
    # A Secret supplying GITHUB_WEBHOOK_SECRET / SLACK_SIGNING_SECRET /
    # SLACK_BOT_TOKEN (+ optionally GITHUB_TOKEN). envFrom-mounted, so the keys
    # must match those env var names (case-insensitive). Empty = none mounted.
    secretName = mkOption {
      type = types.str;
      default = "";
      description = "Name of a Secret (same namespace) envFrom-mounted for provider creds.";
    };

    # Durable mapping store: the PR/Slack <-> conversation map MUST survive a pod
    # restart (else follow-up comments spawn a new conversation instead of resuming).
    # It now lives in the shared platform Postgres (agentSandbox.postgres, always on)
    # — webhooks' own `webhooks` db + auto-provisioned role. No per-module knobs here.

    # The webhooks receiver's own generic Ingress — SEPARATE from the chat ingress
    # and UNAUTHENTICATED (GitHub/Slack/… can't send an identity header; the
    # handlers verify provider signatures themselves). Controller-specific config
    # (cert, scheme, external-dns, …) comes from `annotations` — NO auth here.
    ingress = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Expose the webhooks receiver via a standard Ingress.";
      };
      host = mkOption {
        type = types.str;
        default = "";
        example = "scooter.example.com";
        description = "Public hostname for the webhooks receiver (path /webhooks).";
      };
      className = mkOption {
        type = types.str;
        default = "";
        example = "alb";
        description = "spec.ingressClassName (the controller). Empty = cluster default.";
      };
      annotations = mkOption {
        type = types.attrsOf types.str;
        default = { };
        description = ''
          Annotations on the webhooks Ingress — controller/cert config WITHOUT auth
          (the endpoint must accept unauthenticated provider POSTs).
        '';
      };
      tls = mkOption {
        type = types.bool;
        default = true;
        description = "Add a spec.tls entry for `host` (cert-manager / controllers that read spec.tls).";
      };
      tlsSecretName = mkOption {
        type = types.str;
        default = "";
        description = "TLS Secret for `host` (empty + tls=true emits spec.tls without a secretName).";
      };
    };
  };

  config = lib.mkIf wcfg.enable {
    # mkMerge (NOT `//`): the postgres block reuses the `deployments`/`services`
    # keys, and a shallow `//` would CLOBBER the app's deployment/service with the
    # DB's. mkMerge deep-merges so both survive.
    kubernetes.resources = lib.mkMerge [
    {
      serviceAccounts.agent-webhooks = {
        metadata = { name = "agent-webhooks"; namespace = cfg.namespace; };
      };

      deployments.agent-webhooks = {
        metadata = { name = "agent-webhooks"; namespace = cfg.namespace; };
        spec = {
          # Stateless (Postgres-backed conversation map; handlers spawn on POST) —
          # 2 replicas by default so consolidation can't drop inbound webhooks.
          replicas = cfg.statelessReplicas;
          selector.matchLabels.app = "agent-webhooks";
          template = {
            metadata.labels.app = "agent-webhooks";
            spec = {
              serviceAccountName = "agent-webhooks";
              containers.agent-webhooks = {
                name = "agent-webhooks";
                image = wcfg.image;
                imagePullPolicy = cfg.pullPolicy;
                command = [ "agent-webhooks" ];
                # A lightweight webhook intake service.
                resources = lib.mkDefault {
                  requests = { cpu = "50m"; memory = "128Mi"; };
                  limits = { memory = "512Mi"; };
                };
                ports = [{ containerPort = 8080; name = "http"; }];
                env = [
                  { name = "PORT"; value = "8080"; }
                  {
                    name = "AGENT_HOST_URL";
                    value = "http://agent-host.${cfg.namespace}.svc.cluster.local:8080";
                  }
                  { name = "TEST_WEBHOOK_ENABLED"; value = lib.boolToString wcfg.testWebhook; }
                  { name = "GITHUB_ENABLED"; value = lib.boolToString wcfg.githubEnabled; }
                  { name = "GITLAB_ENABLED"; value = lib.boolToString wcfg.gitlabEnabled; }
                  { name = "SLACK_ENABLED"; value = lib.boolToString wcfg.slackEnabled; }
                  { name = "MENTION_PATTERN"; value = wcfg.mentionPattern; }
                  { name = "LABEL_TRIGGER"; value = wcfg.labelTrigger; }
                  { name = "IGNORE_USERNAMES"; value = lib.concatStringsSep "," wcfg.ignoreUsernames; }
                  { name = "IGNORE_BOT_AUTHORS"; value = lib.boolToString wcfg.ignoreBotAuthors; }
                ] ++ lib.optional (wcfg.githubApp.appId != "")
                  { name = "GITHUB_APP_ID"; value = wcfg.githubApp.appId; }
                ++ lib.optional (wcfg.githubApp.privateKeySecret != null) {
                  name = "GITHUB_APP_PRIVATE_KEY";
                  valueFrom.secretKeyRef = {
                    name = wcfg.githubApp.privateKeySecret.name;
                    key = wcfg.githubApp.privateKeySecret.key;
                  };
                } ++ [
                  { name = "LOG_LEVEL"; value = wcfg.logLevel; }
                  { name = "AGENT_MANAGER_URL"; value = wcfg.managerUrl; }
                ] ++ [
                  # Durable store: the shared platform Postgres (agentSandbox.postgres,
                  # always on). Webhooks' OWN `webhooks` db + auto-provisioned role
                  # (agent-pg-webhooks). DSN assembled app-side from these parts.
                  { name = "DB_HOST"; value = cfg.postgres.host; }
                  { name = "DB_PORT"; value = toString cfg.postgres.port; }
                  { name = "DB_NAME"; value = "webhooks"; }
                  { name = "DB_USER"; value = "webhooks"; }
                  { name = "DB_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-webhooks"; key = "password"; }; }
                ] ++ lib.optional (cfg.postgres.sslmode != null) { name = "DB_SSLMODE"; value = cfg.postgres.sslmode; };
                # (REMOTE_AGENT_JOIN_SECRET was here for the retired /claude-bridge front door,
                # which verified join tokens before proxying. BYO now connects to the BYOC
                # controller, which holds that secret itself — webhooks no longer needs it.)
                # Provider signing secrets / tokens come from a Secret whose keys
                # match the GITHUB_WEBHOOK_SECRET / SLACK_* env var names.
                envFrom = lib.optionals (wcfg.secretName != "") [
                  { secretRef.name = wcfg.secretName; }
                ];
                volumeMounts = [
                  { name = "data"; mountPath = "/data"; }
                  # Projected SA token (audience agent-host) we present to /agui so the
                  # agent-host can verify us (TokenReview) as the trusted caller and
                  # honor a webhook-resolved conversation `owner`.
                  { name = "agent-host-token"; mountPath = "/var/run/secrets/agent-host"; readOnly = true; }
                ];
                readinessProbe.httpGet = { path = "/health"; port = "http"; };
                livenessProbe.httpGet = { path = "/health"; port = "http"; };
              };
              volumes = [
                { name = "data"; emptyDir = { }; }
                {
                  name = "agent-host-token";
                  projected.sources = [{
                    serviceAccountToken = { audience = "agent-host"; path = "token"; expirationSeconds = 3600; };
                  }];
                }
              ];
            };
          };
        };
      };

      services.agent-webhooks = {
        metadata = { name = "agent-webhooks"; namespace = cfg.namespace; };
        spec = {
          selector.app = "agent-webhooks";
          ports = [{ port = 8080; targetPort = "http"; name = "http"; }];
        };
      };
    }
    (lib.mkIf wcfg.ingress.enable {
      # The webhooks Ingress — a generic networking.k8s.io/v1 Ingress, UNAUTH
      # (providers sign their requests; the handlers verify). Controller +
      # cert/scheme/external-dns config come from `annotations` (NO auth), so any
      # controller (ALB, nginx, traefik) works. /webhooks -> agent-webhooks:8080.
      ingresses.agent-webhooks = {
        metadata = {
          name = "agent-webhooks";
          namespace = cfg.namespace;
          annotations = wcfg.ingress.annotations;
        };
        spec = {
          ingressClassName = lib.mkIf (wcfg.ingress.className != "") wcfg.ingress.className;
          rules = [{
            host = wcfg.ingress.host;
            # /webhooks -> provider intake (signature-verified). Deliberately UNAUTH at the
            # ingress: providers cannot send an identity header, so the handlers verify signatures
            # themselves. (The BYO-Claude /claude-bridge front door used to live here too; BYO now
            # connects to the BYOC controller's own ingress — see modules/byoc.nix.)
            http.paths = map (path: {
              inherit path;
              pathType = "Prefix";
              backend.service = { name = "agent-webhooks"; port.number = 8080; };
            }) [ "/webhooks" ];
          }];
          tls = lib.optionals wcfg.ingress.tls [
            ({ hosts = [ wcfg.ingress.host ]; }
              // lib.optionalAttrs (wcfg.ingress.tlsSecretName != "") {
                secretName = wcfg.ingress.tlsSecretName;
              })
          ];
        };
      };
    })
    ];

    # Register with the shared Postgres: the provisioning Job creates the `webhooks`
    # database + a `webhooks` role that owns it (secret agent-pg-webhooks).
    agentSandbox.postgres.consumers.webhooks = { db = "webhooks"; user = "webhooks"; };
  };
}
