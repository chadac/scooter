# Platform manifests — the long-lived deployment of kubenix-agent-manager.
#
# Renders: namespace, the agent-host Deployment + Service, and the RBAC the
# agent-host needs to (a) provision per-conversation Sandboxes/SAs/PVCs and
# (b) exec into sandbox pods.
#
# The agent-sandbox controller + CRDs are installed separately (upstream release
# manifests); this module only deploys OUR platform on top.
#
# Per-conversation Sandboxes are created at runtime by the agent-host via the
# kube API (not here) — see modules/conversation.nix for that shape.

{ kubenix, config, lib, ... }:

let
  cfg = config.agentSandbox;
  # The ingress targets the UI when it's deployed (the UI proxies the API on the
  # same origin); otherwise it targets the agent-host API directly.
  ingressBackend = if cfg.ui.enable then "ui" else "agent-host";
in
{
  imports = [ kubenix.modules.k8s ./broker.nix ./webhooks.nix ];

  options.agentSandbox = with lib; {
    namespace = mkOption {
      type = types.str;
      default = "agent-sandbox";
      description = "Namespace for the platform + sandboxes.";
    };
    registryPrefix = mkOption {
      type = types.str;
      default = "";
      example = "123456789012.dkr.ecr.us-east-1.amazonaws.com/myorg/";
      description = ''
        Registry/repository prefix prepended to the default image names
        (agent-host, agent-broker, agent-webhooks, agent-sandbox-os). Empty =
        bare local names (`agent-host:latest`) for kind/k3s where images are
        side-loaded. Set to an ECR/registry prefix (WITH trailing slash) for a
        real cluster. Per-image options below override this entirely.
      '';
    };
    pullPolicy = mkOption {
      type = types.enum [ "Always" "IfNotPresent" "Never" ];
      default = "IfNotPresent";
      description = ''
        imagePullPolicy for the platform Deployments. IfNotPresent suits
        side-loaded kind/k3s images; Always suits a registry-backed cluster.
      '';
    };
    agentHostImage = mkOption {
      type = types.str;
      default = "${cfg.registryPrefix}agent-host:latest";
      defaultText = literalExpression ''"''${registryPrefix}agent-host:latest"'';
      description = "OCI ref of the agent-host image.";
    };
    sandboxImage = mkOption {
      type = types.str;
      default = "${cfg.registryPrefix}agent-sandbox-os:latest";
      defaultText = literalExpression ''"''${registryPrefix}agent-sandbox-os:latest"'';
      description = "OCI ref of the generic Nix sandbox image.";
    };
    # Generic, DEPLOYMENT-parameterized tool injection — the platform doesn't know
    # what's in these; a deployment fills them with its own .scooter tools + the
    # token audiences / env its tools need. See docs/SCOOTER_DIR_INJECTION.md.
    deployTools = {
      scooterConfigMap = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "A deployment's .scooter ConfigMap to mount at /etc/agent-sandbox/scooter.";
      };
      tokenAudiences = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = "Extra projected SA token audiences a deployment's tools need (mounted at /var/run/secrets/<aud>/token).";
      };
      env = mkOption {
        type = types.attrsOf types.str;
        default = { };
        example = { EXAMPLE_TOOL_URL = "http://example-tool.ns.svc:8080"; };
        description = "Extra env vars a deployment's tools need, set on each sandbox.";
      };
    };
    uiImage = mkOption {
      type = types.str;
      default = "${cfg.registryPrefix}agent-sandbox-ui:latest";
      defaultText = literalExpression ''"''${registryPrefix}agent-sandbox-ui:latest"'';
      description = "OCI ref of the UI image (nginx + static build + API proxy).";
    };
    ui.enable = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Deploy the conversation UI (nginx serving the assistant-ui build and
        proxying /agui + /sessions + the management API to the agent-host).
        When enabled, the ingress targets the UI (which proxies the API);
        when disabled, the ingress targets the agent-host directly.
      '';
    };
    replicas = mkOption {
      type = types.int;
      default = 1;
      description = "agent-host replicas (one host pod runs many goose sessions).";
    };
    fakeAgent = mkOption {
      type = types.bool;
      default = false;
      description = "Run the dummy ACP agent (GOOSE_BIN=fake) — for cluster e2e.";
    };

    serviceAccountRoleArn = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "arn:aws:iam::123456789012:role/agent-host";
      description = ''
        IRSA role ARN annotated onto the agent-host ServiceAccount
        (eks.amazonaws.com/role-arn). The role's trust policy must allow
        system:serviceaccount:<namespace>:agent-host. Used for Bedrock auth.
      '';
    };

    agent = {
      provider = mkOption {
        type = types.str;
        default = "aws_bedrock";
        description = "GOOSE_PROVIDER for the real agent (e.g. aws_bedrock, anthropic).";
      };
      model = mkOption {
        type = types.str;
        default = "us.anthropic.claude-opus-4-7";
        description = ''
          Default GOOSE_MODEL (the model used when a conversation doesn't pick
          one). For Bedrock, the cross-region inference-profile id.
        '';
      };
      availableModels = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = [ "us.anthropic.claude-opus-4-7" "us.anthropic.claude-sonnet-4-6" ];
        description = ''
          Models offered for per-conversation selection (AGENT_AVAILABLE_MODELS,
          comma-separated). The UI/management API lets a conversation override
          the default per-prompt. Empty = only the default model.
        '';
      };
      region = mkOption {
        type = types.str;
        default = "us-east-1";
        description = "AWS_REGION for the agent process (Bedrock region).";
      };
      name = mkOption {
        type = types.str;
        default = "Scooter";
        description = "Display name the agent goes by (AGENT_NAME) — its identity in the UI + prompt.";
      };
      skills = mkOption {
        type = types.attrsOf types.str;
        default = { };
        example = literalExpression ''
          {
            "project-repo.md" = '''
              ---
              name: project-repo
              ---
              The main repo is github.com/example-org/example-app. Clone it with
              `git clone https://github.com/example-org/example-app` to get started.
            ''';
          }
        '';
        description = ''
          Markdown skills injected into the agent as .goosehints (filename ->
          content). Rendered to a ConfigMap mounted at SKILLS_DIR on the
          agent-host and read per conversation — edit the ConfigMap to add/change
          a skill with no image rebuild. Filenames should end in .md.
        '';
      };
    };

    idleSuspendMs = mkOption {
      type = types.int;
      default = 30 * 60 * 1000;
      description = ''
        Idle window before the agent-host auto-suspends a conversation (drops
        the sandbox pod, keeps the PVCs). The agent-host owns the activity
        signal, so it self-manages lifecycle; activity metadata is still
        exposed via the management API for an external controller. 0 disables.
      '';
    };

    auth = {
      # The agent-host trusts an identity header injected by the ingress (an OIDC
      # proxy / forward-auth / basic-auth the deployer configures). It does NOT do
      # login itself. A missing header => the `anonymous` user (single-user/dev).
      # SECURITY: only expose the agent-host behind an ingress that SETS (and
      # strips any client-supplied) these headers — else identity is spoofable.
      # Provider-agnostic: the "header" mode reads userHeader/emailHeader (Traefik,
      # basic-auth, forward-auth, oauth2-proxy, …); "alb-oidc" reads AWS ALB's
      # OIDC headers (sub from x-amzn-oidc-identity, email/name from the signed
      # x-amzn-oidc-data JWT). More providers can be added without config churn.
      mode = mkOption {
        type = types.enum [ "header" "alb-oidc" ];
        default = "header";
        description = "Identity source: `header` (default; a proxy sets userHeader/emailHeader) or `alb-oidc` (AWS ALB OIDC).";
      };
      userHeader = mkOption {
        type = types.str;
        default = "x-auth-user";
        example = "x-forwarded-user";
        description = "header mode: request header carrying the authenticated user id (set by the ingress).";
      };
      emailHeader = mkOption {
        type = types.str;
        default = "x-auth-email";
        example = "x-forwarded-email";
        description = "header mode: request header carrying the user's email (optional; set by the ingress).";
      };
      # ALB with OIDC only puts the `sub` in a header; the email is inside the
      # signed x-amzn-oidc-data JWT. When available it's learned into a shared
      # Postgres table (user_identity) so it can be filled in later; this static
      # map seeds/overrides it for known users (sub -> email). Optional.
      subEmailMap = mkOption {
        type = types.attrsOf types.str;
        default = { };
        example = { "cognito-sub-abc" = "alice@example.com"; };
        description = "Optional static map of user id (OIDC sub) -> email, seeding the learned identity store.";
      };
    };

    observability = {
      otel = {
        enable = mkOption {
          type = types.bool;
          default = false;
          description = ''
            Emit OpenTelemetry metrics (run count/latency, tokens, derived cost,
            sandbox population) over OTLP. OFF by default. The OTLP endpoint +
            headers come from the standard OTEL_EXPORTER_OTLP_* env (set via
            `otel.env` below) — vendor-neutral (Datadog/Grafana/Honeycomb/...).
          '';
        };
        env = mkOption {
          type = types.attrsOf types.str;
          default = { };
          example = {
            OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector.observability:4318";
            OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
          };
          description = ''
            Standard OTEL_EXPORTER_OTLP_* env vars passed through to the
            agent-host (the OTel SDK reads them directly). Point these at your
            collector / vendor endpoint. Only applied when otel.enable = true.
          '';
        };
        environment = mkOption {
          type = types.nullOr types.str;
          default = null;
          example = "dev";
          description = "deployment.environment resource attribute on every metric.";
        };
        pricing = mkOption {
          type = types.attrsOf (types.submodule {
            options = {
              inputPerMillion = mkOption { type = types.either types.int types.float; };
              outputPerMillion = mkOption { type = types.either types.int types.float; };
              cachedReadPerMillion = mkOption { type = types.nullOr (types.either types.int types.float); default = null; };
              cachedWritePerMillion = mkOption { type = types.nullOr (types.either types.int types.float); default = null; };
            };
          });
          default = { };
          example = literalExpression ''
            {
              "us.anthropic.claude-opus-4-7" = { inputPerMillion = 15.0; outputPerMillion = 75.0; cachedReadPerMillion = 1.5; };
              "us.anthropic.claude-sonnet-4-6" = { inputPerMillion = 3.0; outputPerMillion = 15.0; };
            }
          '';
          description = ''
            Per-model price table, USD per 1,000,000 tokens, for cost derivation.
            Rendered to a ConfigMap mounted into the agent-host and read at start.
            A model absent here has its tokens counted but no cost emitted (so $0
            is never reported misleadingly). Edit the ConfigMap to reprice with no
            image rebuild.
          '';
        };
      };
    };

    # Expose the platform via a GENERIC networking.k8s.io/v1 Ingress so deployers
    # can bring their own controller (ALB, nginx, traefik, …) by setting
    # className + annotations. Controller-specific config (auth, the identity
    # header the agent-host trusts, cert ARN / cluster-issuer, etc.) is passed
    # through `annotations` — the module renders a portable Ingress, no CRDs.
    ingress = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Expose the agent-host (AG-UI/API + UI) via a standard Ingress.";
      };
      host = mkOption {
        type = types.str;
        default = "";
        example = "chat.example.com";
        description = "Public hostname for the chat UI / API.";
      };
      className = mkOption {
        type = types.str;
        default = "";
        example = "alb";
        description = ''
          spec.ingressClassName (the controller). Empty = the cluster's default
          IngressClass. e.g. "alb", "nginx", "traefik".
        '';
      };
      annotations = mkOption {
        type = types.attrsOf types.str;
        default = { };
        example = literalExpression ''
          {
            "alb.ingress.kubernetes.io/scheme" = "internet-facing";
            "alb.ingress.kubernetes.io/certificate-arn" = "arn:aws:acm:...";
          }
        '';
        description = ''
          Annotations on the chat Ingress — controller-specific config (cert,
          scheme, AUTH, the trusted identity header, external-dns hostname, …).
          SECURITY: the agent-host trusts an identity header set by the ingress;
          put your auth + header-setting annotations here so unauthenticated
          requests can't spoof a user. Nothing is auth-gated by the module itself.
        '';
      };
      tls = mkOption {
        type = types.bool;
        default = true;
        description = ''
          Add a spec.tls entry for `host`. Needed for cert-manager (the tls block
          triggers issuance) and for controllers that read spec.tls. Deployers
          that terminate TLS at the LB via annotations (e.g. ALB cert-arn) can set
          this false and rely on annotations alone.
        '';
      };
      tlsSecretName = mkOption {
        type = types.str;
        default = "";
        example = "chat-tls";
        description = ''
          The TLS Secret holding the cert for `host` (populated by cert-manager,
          your CD, etc.). Empty + tls=true emits a spec.tls entry WITHOUT a
          secretName (some controllers, e.g. cert-manager with an annotation,
          accept that).
        '';
      };
      # The webhooks receiver has its own ingress options under
      # `agentSandbox.webhooks.ingress` (separate host, NO auth) — see webhooks.nix.
    };
  };

  config = {
    # mkMerge (not //): the optional UI / ingress blocks below ALSO define
    # `deployments` / `services`, and a shallow `//` update would replace the
    # whole `deployments` attrset (dropping agent-host). mkMerge deep-merges.
    kubernetes.resources = lib.mkMerge [
    {
      namespaces.${cfg.namespace} = {
        metadata.name = cfg.namespace;
      };

      serviceAccounts.agent-host = {
        metadata = {
          name = "agent-host";
          namespace = cfg.namespace;
        } // lib.optionalAttrs (cfg.serviceAccountRoleArn != null) {
          annotations."eks.amazonaws.com/role-arn" = cfg.serviceAccountRoleArn;
        };
      };

      # The agent-host provisions per-conversation Sandboxes/SAs/PVCs and execs
      # into sandbox pods, so it needs broad-but-namespaced RBAC.
      roles.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        rules = [
          {
            apiGroups = [ "agents.x-k8s.io" ];
            resources = [ "sandboxes" ];
            verbs = [ "get" "list" "watch" "create" "update" "patch" "delete" ];
          }
          {
            apiGroups = [ "" ];
            resources = [ "serviceaccounts" "persistentvolumeclaims" "pods" ];
            verbs = [ "get" "list" "watch" "create" "update" "patch" "delete" ];
          }
          {
            # Exec is how the ExecBackend runs the agent's commands in the pod.
            apiGroups = [ "" ];
            resources = [ "pods/exec" ];
            # `get` AND `create`: the WebSocket exec stream (client-node, kubectl)
            # opens with an HTTP GET upgrade, which RBAC checks as `get pods/exec`
            # — `create` alone passes `can-i create pods/exec` but the real exec
            # 403s ("cannot get resource pods/exec").
            verbs = [ "get" "create" ];
          }
        ];
      };

      roleBindings.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        roleRef = { apiGroup = "rbac.authorization.k8s.io"; kind = "Role"; name = "agent-host"; };
        subjects = [{ kind = "ServiceAccount"; name = "agent-host"; namespace = cfg.namespace; }];
      };

      deployments.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        spec = {
          replicas = cfg.replicas;
          # Recreate (not the default RollingUpdate): agent-host mounts the
          # single RWO `agent-host-state` PVC, which can't be Multi-Attached to
          # an old + new pod at once. RollingUpdate deadlocks — the new pod waits
          # on the volume the old pod still holds, and the old pod won't drain
          # until the new one is Ready. Recreate stops the old pod first.
          strategy.type = "Recreate";
          selector.matchLabels.app = "agent-host";
          template = {
            metadata.labels.app = "agent-host";
            spec = {
              serviceAccountName = "agent-host";
              # The state PVC (EBS/ext4) is owned root:root with restrictive
              # access; the agent-host process can't write its per-conversation
              # dirs without an fsGroup that the kubelet uses to relabel/chgrp
              # the volume. 0 = root group (the uid the container runs as).
              securityContext = {
                fsGroup = 0;
                fsGroupChangePolicy = "OnRootMismatch";
              };
              containers.agent-host = {
                name = "agent-host";
                image = cfg.agentHostImage;
                imagePullPolicy = cfg.pullPolicy;
                ports = [{ containerPort = 8080; name = "agui"; }];
                env = [
                  { name = "PORT"; value = "8080"; }
                  { name = "NAMESPACE"; value = cfg.namespace; }
                  { name = "SANDBOX_IMAGE"; value = cfg.sandboxImage; }
                  # Durable: the AG-UI event log (history) on the PVC.
                  { name = "STATE_PATH"; value = "/var/lib/agent-host/conversations"; }
                  # Ephemeral scratch (emptyDir): goose's per-conversation cwd +
                  # $HOME (sessions DB + .goosehints). The agent's real work execs
                  # into the SANDBOX, so none of this is durable — keeping it off
                  # the PVC avoids the SELinux/fsGroup subdir-context problems an
                  # EBS volume hits, and the image's "/" default is unwritable.
                  { name = "SCRATCH_PATH"; value = "/var/lib/agent-scratch"; }
                  { name = "HOME"; value = "/var/lib/agent-scratch/home"; }
                  { name = "IDLE_SUSPEND_MS"; value = toString cfg.idleSuspendMs; }
                  # Agent identity + skills: the agent-host writes these into the
                  # per-conversation .goosehints. SKILLS_DIR is the ConfigMap mount.
                  { name = "AGENT_NAME"; value = cfg.agent.name; }
                  { name = "SKILLS_DIR"; value = "/etc/agent-sandbox/skills"; }
                ] ++ lib.optional (cfg.ingress.enable && cfg.ingress.host != "")
                  # Public chat UI base URL → each sandbox gets a CONVERSATION_URL
                  # to its own conversation (the agent can share the link, e.g. to
                  # have a human approve an AWS request).
                  { name = "PUBLIC_URL"; value = "https://${cfg.ingress.host}"; }
                ++ lib.optional (cfg.auth.mode != "header")
                  # Identity provider: header (default) or alb-oidc.
                  { name = "AUTH_MODE"; value = cfg.auth.mode; }
                ++ lib.optional (cfg.auth.userHeader != "x-auth-user")
                  # Identity header the ingress injects (default x-auth-user).
                  { name = "AUTH_USER_HEADER"; value = cfg.auth.userHeader; }
                ++ lib.optional (cfg.auth.emailHeader != "x-auth-email")
                  { name = "AUTH_EMAIL_HEADER"; value = cfg.auth.emailHeader; }
                ++ lib.optional (cfg.auth.subEmailMap != { })
                  # Static sub->email seed for the learned identity store ("k=v,k=v").
                  { name = "AUTH_SUB_EMAIL_MAP";
                    value = lib.concatStringsSep "," (lib.mapAttrsToList (k: v: "${k}=${v}") cfg.auth.subEmailMap); }
                ++ lib.optionals (!cfg.fakeAgent) [
                  # Real `goose acp` on Bedrock (or another provider). The agent
                  # process inherits the pod's IRSA identity via the AWS SDK
                  # web-identity chain — no static keys.
                  { name = "GOOSE_PROVIDER"; value = cfg.agent.provider; }
                  { name = "GOOSE_MODEL"; value = cfg.agent.model; }
                  { name = "AWS_REGION"; value = cfg.agent.region; }
                  { name = "AWS_DEFAULT_REGION"; value = cfg.agent.region; }
                ] ++ lib.optional (!cfg.fakeAgent && cfg.agent.availableModels != [ ])
                  # Models offered for per-conversation selection (the management
                  # API/UI may override GOOSE_MODEL per conversation).
                  { name = "AGENT_AVAILABLE_MODELS"; value = lib.concatStringsSep "," cfg.agent.availableModels; }
                ++ lib.optional cfg.fakeAgent
                  # Run the bundled dummy ACP agent (no model/cluster) — for the
                  # spawn-from-webhook + UI e2e on the cluster.
                  { name = "GOOSE_BIN"; value = "fake"; }
                ++ lib.optionals cfg.broker.aws.enable [
                  # AWS permissions broker: the agent-host mounts the account
                  # ConfigMap into each sandbox, and resolves approvals against the
                  # broker (BROKER_URL + the projected SA token).
                  { name = "AWS_ACCOUNTS_CONFIGMAP"; value = "agent-broker-aws-accounts"; }
                  { name = "BROKER_URL"; value = "http://agent-broker.${cfg.namespace}.svc.cluster.local:8080"; }
                  { name = "BROKER_TOKEN_PATH"; value = "/var/run/secrets/broker/token"; }
                ] ++ lib.optionals (cfg.deployTools.scooterConfigMap != null) [
                  # Deployment tool injection (generic): the agent-host mounts the
                  # deployment's .scooter ConfigMap + projects the named token
                  # audiences + sets the deployment env on each sandbox.
                  { name = "SCOOTER_CONFIGMAP"; value = cfg.deployTools.scooterConfigMap; }
                ] ++ lib.optional (cfg.deployTools.tokenAudiences != [ ])
                  { name = "SCOOTER_TOKEN_AUDIENCES"; value = lib.concatStringsSep "," cfg.deployTools.tokenAudiences; }
                ++ lib.optional (cfg.deployTools.env != { })
                  { name = "SCOOTER_ENV"; value = lib.concatStringsSep ";" (lib.mapAttrsToList (k: v: "${k}=${v}") cfg.deployTools.env); }
                ++ lib.optionals cfg.observability.otel.enable ([
                  # OTel metrics ON. The OTLP endpoint/headers come from the
                  # OTEL_EXPORTER_OTLP_* env in observability.otel.env (the SDK
                  # reads them). Pricing comes from the mounted ConfigMap.
                  { name = "OTEL_METRICS_ENABLED"; value = "1"; }
                  { name = "OTEL_SERVICE_NAME"; value = "agent-host"; }
                ] ++ lib.optional (cfg.observability.otel.environment != null)
                    { name = "OTEL_DEPLOYMENT_ENVIRONMENT"; value = cfg.observability.otel.environment; }
                  ++ lib.optional (cfg.observability.otel.pricing != { })
                    { name = "AGENT_PRICING_FILE"; value = "/etc/agent-sandbox/pricing/pricing.json"; }
                  ++ lib.mapAttrsToList (k: v: { name = k; value = v; }) cfg.observability.otel.env)
                ++ lib.optionals (cfg.webhooks.enable && cfg.webhooks.postgres.enable && cfg.webhooks.postgres.passwordSecret != null) [
                  # READ access to the webhooks conversation_map (shared Postgres),
                  # so the agent-tools can DISCOVER a conversation's slack/PR/MR/issue
                  # target when its link has no structured `ref` (fallback). Same DB
                  # the webhooks service writes; reuses its password secret.
                  { name = "WEBHOOKS_DB_HOST"; value = "agent-shared-db.${cfg.namespace}.svc.cluster.local"; }
                  { name = "WEBHOOKS_DB_NAME"; value = cfg.webhooks.postgres.database; }
                  { name = "WEBHOOKS_DB_USER"; value = cfg.webhooks.postgres.user; }
                  {
                    name = "WEBHOOKS_DB_PASSWORD";
                    valueFrom.secretKeyRef = {
                      inherit (cfg.webhooks.postgres.passwordSecret) name key;
                    };
                  }
                ];
                volumeMounts = [
                  # Durable history (PVC).
                  { name = "state"; mountPath = "/var/lib/agent-host"; }
                  # Ephemeral agent scratch (emptyDir): goose cwd + $HOME.
                  { name = "scratch"; mountPath = "/var/lib/agent-scratch"; }
                  # The image's /tmp is read-only (nix store). goose needs a
                  # writable /tmp for session/new temp files — mount one.
                  { name = "tmp"; mountPath = "/tmp"; }
                ] ++ lib.optional (cfg.agent.skills != { })
                  # Skills ConfigMap -> read per conversation into .goosehints.
                  { name = "skills"; mountPath = "/etc/agent-sandbox/skills"; readOnly = true; }
                ++ lib.optional (cfg.observability.otel.enable && cfg.observability.otel.pricing != { })
                  # Per-model price table -> cost derivation (AGENT_PRICING_FILE).
                  { name = "pricing"; mountPath = "/etc/agent-sandbox/pricing"; readOnly = true; }
                ++ lib.optional cfg.broker.aws.enable
                  # The agent-host's own broker token (to relay AWS approve/deny).
                  { name = "broker-token"; mountPath = "/var/run/secrets/broker"; readOnly = true; };
                readinessProbe.httpGet = { path = "/healthz"; port = "agui"; };
              };
              # Durable event-log PVC + ephemeral scratch/tmp emptyDirs.
              volumes = [
                { name = "state"; persistentVolumeClaim.claimName = "agent-host-state"; }
                { name = "scratch"; emptyDir = { }; }
                { name = "tmp"; emptyDir = { }; }
              ] ++ lib.optional (cfg.agent.skills != { })
                { name = "skills"; configMap.name = "agent-skills"; }
              ++ lib.optional (cfg.observability.otel.enable && cfg.observability.otel.pricing != { })
                { name = "pricing"; configMap.name = "agent-pricing"; }
              ++ lib.optional cfg.broker.aws.enable
                { name = "broker-token"; projected.sources = [{ serviceAccountToken = { audience = "agent-broker"; path = "token"; }; }]; };
            };
          };
        };
      };

      persistentVolumeClaims.agent-host-state = {
        metadata = { name = "agent-host-state"; namespace = cfg.namespace; };
        spec = {
          accessModes = [ "ReadWriteOnce" ];
          resources.requests.storage = "5Gi";
        };
      };

      # Agent skills (filename -> markdown), injected per conversation as
      # .goosehints. Edit this (the option) to add/change a skill — no image
      # rebuild. Only rendered when skills are configured.
      configMaps = lib.optionalAttrs (cfg.agent.skills != { }) {
        agent-skills = {
          metadata = { name = "agent-skills"; namespace = cfg.namespace; };
          data = cfg.agent.skills;
        };
      } // lib.optionalAttrs (cfg.observability.otel.enable && cfg.observability.otel.pricing != { }) {
        # Per-model price table (USD per 1M tokens) -> cost derivation. Serialized
        # to the shape pricing.ts parses; null cached rates are dropped.
        agent-pricing = {
          metadata = { name = "agent-pricing"; namespace = cfg.namespace; };
          data."pricing.json" = builtins.toJSON (
            lib.mapAttrs
              (_model: p:
                { inherit (p) inputPerMillion outputPerMillion; }
                // lib.optionalAttrs (p.cachedReadPerMillion != null) { inherit (p) cachedReadPerMillion; }
                // lib.optionalAttrs (p.cachedWritePerMillion != null) { inherit (p) cachedWritePerMillion; })
              cfg.observability.otel.pricing
          );
        };
      };

      services.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        spec = {
          selector.app = "agent-host";
          ports = [{ port = 8080; targetPort = "agui"; name = "agui"; }];
        };
      };
    }
    (lib.mkIf cfg.ui.enable {
      # Conversation UI — nginx serving the assistant-ui build and proxying the
      # agent-host API on the same origin (so the browser's /agui SSE + /sessions
      # + management calls work without CORS).
      deployments.ui = {
        metadata = { name = "ui"; namespace = cfg.namespace; };
        spec = {
          replicas = 1;
          selector.matchLabels.app = "ui";
          template = {
            metadata.labels.app = "ui";
            spec.containers.ui = {
              name = "ui";
              image = cfg.uiImage;
              imagePullPolicy = cfg.pullPolicy;
              ports = [{ containerPort = 8080; name = "http"; }];
              env = [{
                name = "AGENT_HOST_URL";
                value = "http://agent-host.${cfg.namespace}.svc.cluster.local:8080";
              }];
              readinessProbe.httpGet = { path = "/"; port = "http"; };
            };
          };
        };
      };

      services.ui = {
        metadata = { name = "ui"; namespace = cfg.namespace; };
        spec = {
          selector.app = "ui";
          ports = [{ port = 8080; targetPort = "http"; name = "http"; }];
        };
      };
    })
    (lib.mkIf cfg.ingress.enable {
      # The chat/API Ingress — a generic networking.k8s.io/v1 Ingress. The
      # controller (className) + all controller-specific config (TLS cert, scheme,
      # AUTH + the trusted identity header, external-dns hostname, …) come from
      # `annotations`, so any controller (ALB, nginx, traefik) works. SECURITY: the
      # agent-host trusts an identity header the ingress sets — that auth lives in
      # `annotations` (the module gates nothing itself).
      ingresses.agent-host = {
        metadata = {
          name = "agent-host";
          namespace = cfg.namespace;
          annotations = cfg.ingress.annotations;
        };
        spec = {
          ingressClassName = lib.mkIf (cfg.ingress.className != "") cfg.ingress.className;
          rules = [{
            host = cfg.ingress.host;
            http.paths = [{
              path = "/";
              pathType = "Prefix";
              backend.service = { name = ingressBackend; port.number = 8080; };
            }];
          }];
          tls = lib.optionals cfg.ingress.tls [
            ({ hosts = [ cfg.ingress.host ]; }
              // lib.optionalAttrs (cfg.ingress.tlsSecretName != "") {
                secretName = cfg.ingress.tlsSecretName;
              })
          ];
        };
      };
    })
    # NOTE: the webhooks receiver gets its OWN generic Ingress, defined in
    # webhooks.nix (its own host + annotations + NO auth — providers can't send an
    # identity header; the handlers verify provider signatures themselves).
    ];
  };
}
