# Webhooks: Deployment, Service and optional Ingress.
#
# Receives provider webhooks (GitHub/GitLab/Jira/Slack) and spawns agent
# conversations via the agent-host /agui. Providers authenticate by HMAC
# signature, so the ingress stays unauthenticated; an auth middleware in front
# of it would reject deliveries before the signature check runs. See
# docs/WEBHOOKS.md and services/webhooks/.

{ config, options, lib, ... }:

let
  cfg = config.scooter;
  wcfg = cfg.webhooks;
  # Each contrib owns its own webhook handler's settings now.
  removed = {
    githubEnabled = "Set `contribs.github.webhooksEnabled` instead.";
    gitlabEnabled = "Set `contribs.gitlab.webhooksEnabled` instead.";
    slackEnabled = "Set `contribs.slack.webhooksEnabled` instead.";
    githubApp = "The handler uses `contribs.github.appId` and `contribs.github.privateKeySecret`.";
  };
  # A throw, since kubenix has no `assertions` option for mkRemovedOptionModule.
  removedGuard = v:
    let set = lib.filterAttrs (n: _: options.scooter.webhooks.${n}.isDefined) removed;
    in if set == { } then v
    else throw (lib.concatStrings (lib.mapAttrsToList
      (n: msg: "`scooter.webhooks.${n}` was removed. ${msg}\n") set));
in
{
  options.scooter.webhooks = lib.mapAttrs (_: _: lib.mkOption {
    type = lib.types.raw;
    visible = false;
    description = "Removed.";
  }) removed // (with lib; {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Deploy the webhooks service.";
    };
    image = mkOption {
      type = types.str;
      default = cfg.images.agent-webhooks.ref.fullUrl;
      defaultText = literalExpression "config.scooter.images.agent-webhooks.ref.fullUrl";
      description = "OCI ref of the webhooks image.";
    };
    testWebhook = mkOption {
      type = types.bool;
      default = false;
      description = "Enable /webhooks/test for the spawn-from-webhook e2e.";
    };

    # A contrib's deployment.nix adds env to the Deployment declared here through
    # this seam, gated on its own `enable`, so provider-specific flags stay in the
    # contrib.
    extraEnv = mkOption {
      type = types.listOf (types.attrsOf types.anything);
      default = [ ];
      example = literalExpression ''[ { name = "JIRA_ENABLED"; value = "true"; } ]'';
      description = ''
        Extra env entries appended to the webhooks container. A NAME declared twice
        is not an error here and k8s silently keeps the last value, so a contrib
        must own its prefix.
      '';
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
      description = "Issue/PR label name that triggers a conversation (GitHub/GitLab/Jira).";
    };
    ignoreUsernames = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "scooter-acme[bot]" "dependabot[bot]" ];
      description = ''
        Comment/review authors to drop outright (IGNORE_USERNAMES), matched
        case-insensitively — e.g. a noisy third-party bot. GitHub recognizes the
        agent's own comments from the App identity (`contribs.github.appId`), and
        GitLab from the user its token belongs to, so this is for OTHER authors.
      '';
    };
    ignoreBotAuthors = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Fallback for deployments with no `contribs.github.appId`: drop GitHub
        comments/reviews authored by any Bot account unless they mention the
        agent. With the App set the agent's own comments are recognized by
        login and this only affects OTHER bots. Disable if you rely on a bot
        relaying human content without a mention.
      '';
    };
    logLevel = mkOption {
      type = types.str;
      default = "INFO";
      example = "DEBUG";
      description = "Root log level (LOG_LEVEL) — DEBUG for verbose tracing.";
    };

    # Defaults from the chat host whenever it is set, regardless of
    # ingress.enable, since the host is the public URL either way.
    managerUrl = mkOption {
      type = types.str;
      default = if cfg.ingress.host != "" then "https://${cfg.ingress.host}" else "";
      defaultText = lib.literalExpression ''"https://''${scooter.ingress.host}" (when the chat host is set)'';
      description = "Public UI base URL for the 'View conversation' deep-links (AGENT_MANAGER_URL).";
    };

    # --- Provider secrets ---------------------------------------------------
    # envFrom-mounted, so the keys must match the env var names.
    secretName = mkOption {
      type = types.str;
      default = "";
      description = "Name of a Secret (same namespace) envFrom-mounted for provider creds.";
    };

    # The receiver's own Ingress, separate from the chat ingress and
    # unauthenticated.
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
  });

  # The table declarations are unconditional (see modules/db-spec.nix); everything
  # else is gated on `enable`.
  config = lib.mkMerge [

  # The tables the `webhooks` database holds, from which owners.toml, the
  # migrator's database list and the postgres GRANTs are generated.
  {
    scooter.db.webhooks = {
      owner = "webhooks";
      tables = {
        conversation_map = { writers = [ "webhooks" ]; readers = [ "agent-host" ]; };
        conversation_vars = {
          writers = [ "webhooks" "agent-host" ];
          note = ''
            Hidden per-conversation state for contribs. Webhooks reads and writes it;
            agent-host only deletes a conversation's rows when the conversation is removed.'';
        };
        resource_links = {
          writers = [ "webhooks" "agent-host" ];
          readers = [ "conversation-router" ];
          note = ''
            Webhooks OWNS this table; agent-host also WRITES it (the conversation link panel).
            Two writers, one table — the same shape as byoc.remote_agents.
            conversation-router READS it (SELECT-only) to enrich the conversation list with link badges.'';
        };
        pending_messages = { writers = [ "webhooks" ]; };
        user_identity = { writers = [ "agent-host" ]; readers = [ "webhooks" ]; };
      };
    };
  }
  (lib.mkIf (removedGuard wcfg.enable) {
    # Deep-merged so the ingress block's additions coexist with the Deployment.
    kubernetes.resources = lib.mkMerge [
    {
      serviceAccounts.agent-webhooks = {
        metadata = { name = "agent-webhooks"; namespace = cfg.namespace; };
      };

      deployments.agent-webhooks = {
        metadata = { name = "agent-webhooks"; namespace = cfg.namespace; };
        spec = {
          # Stateless; the conversation map lives in Postgres.
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
                  { name = "MENTION_PATTERN"; value = wcfg.mentionPattern; }
                  { name = "LABEL_TRIGGER"; value = wcfg.labelTrigger; }
                  { name = "IGNORE_USERNAMES"; value = lib.concatStringsSep "," wcfg.ignoreUsernames; }
                  { name = "IGNORE_BOT_AUTHORS"; value = lib.boolToString wcfg.ignoreBotAuthors; }
                ] ++ [
                  { name = "LOG_LEVEL"; value = wcfg.logLevel; }
                  { name = "AGENT_MANAGER_URL"; value = wcfg.managerUrl; }
                ] ++ [
                  # The service's own `webhooks` db in the shared Postgres.
                  { name = "DB_HOST"; value = cfg.postgres.host; }
                  { name = "DB_PORT"; value = toString cfg.postgres.port; }
                  { name = "DB_NAME"; value = "webhooks"; }
                  { name = "DB_USER"; value = "webhooks"; }
                  { name = "DB_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-webhooks"; key = "password"; }; }
                ] ++ lib.optional (cfg.postgres.sslmode != null) { name = "DB_SSLMODE"; value = cfg.postgres.sslmode; }
                  ++ cfg.contribDbEnv.webhooks ++ wcfg.extraEnv;
                # Provider signing secrets come from a Secret whose keys match the
                # env var names.
                envFrom = lib.optionals (wcfg.secretName != "") [
                  { secretRef.name = wcfg.secretName; }
                ];
                volumeMounts = [
                  { name = "data"; mountPath = "/data"; }
                  # Projected SA token presented to /agui so the agent-host honors a
                  # webhook-resolved `owner`.
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
                    serviceAccountToken = { audience = "scooter-router"; path = "token"; expirationSeconds = 3600; };
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
      # A generic unauthenticated Ingress; controller config comes from
      # `annotations`.
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
            # The signature-verified provider intake.
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

    # The provisioning Job creates the `webhooks` database and its owner role.
    scooter.postgres.consumers.webhooks = { db = "webhooks"; user = "webhooks"; };
  })
  ];
}
