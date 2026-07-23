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

  # --- Model catalog: fold the availableModels attrset (+ the deprecated
  # agent.model) into the rich list the agent-host reads as AGENT_MODELS_JSON.
  enabledModels = lib.filterAttrs (_: m: m.enable) cfg.agent.availableModels;
  # An explicit default = true wins; else the deprecated agent.model; else the
  # first enabled model.
  explicitDefault = lib.findFirst (id: enabledModels.${id}.default) null (lib.attrNames enabledModels);
  defaultModelId =
    if explicitDefault != null then explicitDefault
    else if cfg.agent.model != null then cfg.agent.model
    else if enabledModels != { } then lib.head (lib.attrNames enabledModels)
    else null;
  # The offered set: the enabled attrset ids, plus the deprecated agent.model if it
  # isn't already present (back-compat).
  modelIds = lib.unique (
    (lib.attrNames enabledModels)
    ++ lib.optional (cfg.agent.model != null && !(enabledModels ? ${cfg.agent.model})) cfg.agent.model
  );
  modelsJson = builtins.toJSON (map (id: {
    inherit id;
    hint = enabledModels.${id}.hint or "";
    default = id == defaultModelId;
  }) modelIds);
  hasModels = modelIds != [ ];
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
    sandboxViaBroker = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Route the sandbox LIFECYCLE (create/suspend/resume/destroy + sizing) through
        the BROKER instead of the agent-host touching k8s directly (the control-plane
        move — see todo/CONTROL_PLANE_REDESIGN.md). When true:
          - the agent-host runs with SANDBOX_VIA_BROKER=1 and its RBAC collapses to
            pods/exec only (the broker owns Sandbox/SA/PVC/CM CRUD),
          - the broker gets the provisioning RBAC + the deployment provisioning config
            (image, overlay, .scooter CM, default size, …) as its own env.
        Default false keeps the legacy in-agent-host k8s provisioner (rollback path).
      '';
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
        example = {
          EXAMPLE_TOOL_URL = "http://example-tool.ns.svc:8080";
          # Multi-line values are fine (carried as JSON, not k=v;k=v):
          NIX_CONFIG = "extra-substituters = http://cache/itops\nflake-registry = /etc/nix/registry.json";
        };
        description = ''
          Extra env vars a deployment's tools need, set on each sandbox. Values may
          contain newlines, `;`, and `=` — they're carried to the pod as JSON
          (SCOOTER_ENV), so a multi-line NIX_CONFIG survives intact.
        '';
      };
      configFiles = mkOption {
        type = types.attrsOf types.lines;
        default = { };
        example = {
          "nix.conf" = ''
            extra-substituters = http://atticd.nix-cache.svc:8080/itops
            extra-trusted-public-keys = itops:AAAA…=
          '';
          "registry.json" = ''{"flakes":[],"version":2}'';
        };
        description = ''
          Config FILES to mount into every sandbox, as a flat directory at
          `/etc/agent-sandbox/config/`. Keys are plain filenames (no slashes),
          values are file contents; files sit side-by-side so one can reference
          another by relative name (e.g. `import ./module.nix`).

          Use this — not `env` — for multi-line config a tool reads as a file (e.g.
          a nix.conf). ConfigMap data is mounted byte-for-byte by the kubelet, so it
          sidesteps the sandbox CRD controller's env-var newline corruption (a
          multi-line value passed via `env` arrives with literal `\n`). Mounted
          read-only.
        '';
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
        type = types.nullOr types.str;
        default = null;
        description = ''
          DEPRECATED — use `availableModels.<id>.default = true` instead. When set
          (and no availableModels entry is marked default), it's the default model
          and is added to the offered set (back-compat for existing deploys). For
          Bedrock, the cross-region inference-profile id.
        '';
      };
      availableModels = mkOption {
        type = types.attrsOf (types.submodule ({ name, ... }: {
          options = {
            enable = mkOption {
              type = types.bool;
              default = true;
              description = "Offer this model for selection.";
            };
            default = mkOption {
              type = types.bool;
              default = false;
              description = "Mark this as the default model (exactly one should be true).";
            };
            hint = mkOption {
              type = types.str;
              default = "";
              example = "Fast + cheap — simple edits, config/CI fixes.";
              description = ''
                Deployment guidance shown to the agent by the `list_models` MCP
                tool, steering when to pick this model (e.g. fast/cheap vs
                slow/powerful). Empty = no hint.
              '';
            };
          };
        }));
        default = { };
        example = literalExpression ''
          {
            "us.anthropic.claude-sonnet-4-6" = { default = true; hint = "Fast + cheap — simple edits/CI fixes."; };
            "us.anthropic.claude-opus-4-8" = { hint = "Slow + powerful — architecture, hard debugging."; };
          }
        '';
        description = ''
          The models a conversation may run on, each with an optional `hint`
          (surfaced by the list_models MCP tool so the agent can pick well) and a
          `default` flag (exactly one). The agent switches its own model via
          switch_model; the UI/management API can also override per-conversation.
          Rendered to the agent-host as AGENT_MODELS_JSON. Empty = only the default.
        '';
      };
      region = mkOption {
        type = types.str;
        default = "us-east-1";
        description = "AWS_REGION for the agent process (Bedrock region).";
      };
      claudeCode = {
        tokenSecret = mkOption {
          type = types.str;
          default = "agent-claude-code-token";
          description = ''
            When `agent.provider = "claude-code"`, the name of the Secret holding the
            long-lived subscription OAuth token (`claude setup-token`) under key `token`.
            Wired to CLAUDE_CODE_OAUTH_TOKEN on the agent-host. Requires the claude CLI in
            the image (build .#agent-host-image-claude). Create the Secret out-of-band:
            kubectl create secret generic <name> --from-literal=token=$(claude setup-token).
          '';
        };
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
      # Optional hardening for alb-oidc: cryptographically verify the ALB's
      # x-amzn-oidc-data JWT signature (fetch the ALB public key by kid) before
      # trusting its email/name claims. On a verify failure the id (from the
      # separate header) is kept but the claims are dropped. Off by default (the
      # ALB is already the trust boundary).
      albVerify = mkOption {
        type = types.bool;
        default = false;
        description = "alb-oidc: verify the x-amzn-oidc-data JWT signature (fetch ALB's public key) before trusting its claims.";
      };
      albRegion = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Region for the ALB public-key endpoint. REQUIRED when albVerify = true (no silent default — the public-key host is region-specific).";
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
        default = true;
        description = ''
          Expose the agent-host (AG-UI/API + UI) via a standard Ingress. On by
          default so a deploy is reachable by hostname out of the box.

          SECURITY: the module auth-gates NOTHING itself — the agent-host trusts an
          identity header the ingress sets (see `annotations`). A default-on ingress
          with no auth annotations is fine for a trusted/local network but is an
          UNAUTHENTICATED, identity-spoofable UI if reachable by untrusted clients.
          Put your auth (and the header-setting) config in `annotations`, or set
          `ingress.enable = false` where you don't want it exposed.
        '';
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
      #
      # Control-plane move (cfg.sandboxViaBroker): the broker owns Sandbox/SA/PVC/CM
      # CRUD, so the agent-host RBAC COLLAPSES to `pods/exec` only. Default false
      # keeps ALL current rules (the legacy in-agent-host k8s provisioner).
      roles.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        rules =
          # The one rule kept in BOTH paths: exec is how the ExecBackend runs the
          # agent's commands in the pod. `get` AND `create`: the WebSocket exec
          # stream (client-node, kubectl) opens with an HTTP GET upgrade, which RBAC
          # checks as `get pods/exec` — `create` alone passes `can-i create
          # pods/exec` but the real exec 403s ("cannot get resource pods/exec").
          let execRule = {
            apiGroups = [ "" ];
            resources = [ "pods/exec" ];
            verbs = [ "get" "create" ];
          };
          in if cfg.sandboxViaBroker then [ execRule ] else [
            {
              apiGroups = [ "agents.x-k8s.io" ];
              resources = [ "sandboxes" ];
              verbs = [ "get" "list" "watch" "create" "update" "patch" "delete" ];
            }
            {
              apiGroups = [ "" ];
              # configmaps: the agent-host creates a per-conversation module ConfigMap
              # (agent-self-modify) BEFORE the Sandbox in k8sProvisioner.create(); a
              # missing `create configmaps` grant 403s provisioning → every new
              # conversation hangs with no reply.
              resources = [ "serviceaccounts" "persistentvolumeclaims" "pods" "configmaps" ];
              verbs = [ "get" "list" "watch" "create" "update" "patch" "delete" ];
            }
            execRule
          ];
      };

      # TokenReview is cluster-scoped → ClusterRole + ClusterRoleBinding. The
      # agent-host verifies the webhooks SA token on /agui (to honor a conversation
      # `owner`), mirroring the broker's SA-token auth.
      clusterRoles.agent-host-tokenreview = {
        metadata.name = "agent-host-tokenreview";
        rules = [{
          apiGroups = [ "authentication.k8s.io" ];
          resources = [ "tokenreviews" ];
          verbs = [ "create" ];
        }];
      };

      clusterRoleBindings.agent-host-tokenreview = {
        metadata.name = "agent-host-tokenreview";
        roleRef = {
          apiGroup = "rbac.authorization.k8s.io";
          kind = "ClusterRole";
          name = "agent-host-tokenreview";
        };
        subjects = [{
          kind = "ServiceAccount";
          name = "agent-host";
          namespace = cfg.namespace;
        }];
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
                # Requests so the scheduler places the platform pods deliberately
                # (they were resource-less, which let them all pack onto one node
                # that then fell over). Memory-limited to protect the node; no cpu
                # limit (bursty provisioning uses spare CPU). agent-host hosts goose +
                # drives provisioning, so it gets the largest platform reservation.
                resources = lib.mkDefault {
                  requests = { cpu = "250m"; memory = "512Mi"; };
                  limits = { memory = "1Gi"; };
                };
                ports = [{ containerPort = 8080; name = "agui"; }];
                env = [
                  { name = "PORT"; value = "8080"; }
                  { name = "NAMESPACE"; value = cfg.namespace; }
                  { name = "SANDBOX_IMAGE"; value = cfg.sandboxImage; }
                  # imagePullPolicy for the per-conversation sandbox pods — mirror the
                  # platform pullPolicy (IfNotPresent for side-loaded kind/k3s, Always
                  # for a registry). Without this the provisioner defaults to "Always",
                  # which fails ImagePullBackOff on a local cluster with no registry.
                  { name = "SANDBOX_PULL_POLICY"; value = cfg.pullPolicy; }
                  # The trusted webhooks SA the agent-host lets set a conversation
                  # `owner` on /agui (verified via TokenReview). Only this SA is
                  # honored; unset = owner never honored.
                  { name = "WEBHOOKS_SERVICE_ACCOUNT"; value = "system:serviceaccount:${cfg.namespace}:agent-webhooks"; }
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
                ] ++ lib.optional (cfg.ingress.host != "")
                  # Public chat UI base URL → each sandbox gets a CONVERSATION_URL
                  # to its own conversation (the agent can share the link, e.g. to
                  # have a human approve an AWS request). Set WHENEVER the host is
                  # configured — NOT gated on ingress.enable: the host is the public
                  # URL even when scooter doesn't render its own Ingress (e.g. an
                  # oauth2-proxy reverse-proxy fronts it). Gating on enable left
                  # PUBLIC_URL/CONVERSATION_URL empty in that setup.
                  { name = "PUBLIC_URL"; value = "https://${cfg.ingress.host}"; }
                ++ lib.optional (cfg.auth.mode != "header")
                  # Identity provider: header (default) or alb-oidc.
                  { name = "AUTH_MODE"; value = cfg.auth.mode; }
                ++ lib.optional cfg.auth.albVerify
                  # Verify the ALB x-amzn-oidc-data JWT signature before trusting
                  # it. Requires a region (the public-key host is region-specific:
                  # public-keys.auth.elb.<region>.amazonaws.com) — assert rather
                  # than silently guessing.
                  (assert lib.assertMsg (cfg.auth.albRegion != null)
                    "agentSandbox.auth.albVerify = true requires agentSandbox.auth.albRegion to be set (the ALB public-key endpoint is region-specific).";
                    { name = "AUTH_ALB_VERIFY"; value = "1"; })
                ++ lib.optional cfg.auth.albVerify
                  { name = "AUTH_ALB_REGION"; value = cfg.auth.albRegion; }
                ++ lib.optional (cfg.auth.userHeader != "x-auth-user")
                  # Identity header the ingress injects (default x-auth-user).
                  { name = "AUTH_USER_HEADER"; value = cfg.auth.userHeader; }
                ++ lib.optional (cfg.auth.emailHeader != "x-auth-email")
                  { name = "AUTH_EMAIL_HEADER"; value = cfg.auth.emailHeader; }
                ++ lib.optional (cfg.auth.subEmailMap != { })
                  # Static sub->email seed for the learned identity store ("k=v,k=v").
                  { name = "AUTH_SUB_EMAIL_MAP";
                    value = lib.concatStringsSep "," (lib.mapAttrsToList (k: v: "${k}=${v}") cfg.auth.subEmailMap); }
                ++ lib.optional (!cfg.fakeAgent)
                  # Real `goose acp`. The provider selects the model backend.
                  { name = "GOOSE_PROVIDER"; value = cfg.agent.provider; }
                ++ lib.optionals (!cfg.fakeAgent && cfg.agent.provider != "claude-code") [
                  # Bedrock (or another AWS-backed provider): the agent process inherits
                  # the pod's IRSA identity via the AWS SDK web-identity chain — no keys.
                  { name = "AWS_REGION"; value = cfg.agent.region; }
                  { name = "AWS_DEFAULT_REGION"; value = cfg.agent.region; }
                ] ++ lib.optionals (!cfg.fakeAgent && cfg.agent.provider == "claude-code") [
                  # claude-code provider: goose shells out to the `claude` CLI (baked into
                  # the image via withClaudeCode). It authenticates with a long-lived
                  # subscription OAuth token (`claude setup-token`) supplied via a Secret.
                  { name = "CLAUDE_CODE_COMMAND"; value = "claude"; }
                  {
                    name = "CLAUDE_CODE_OAUTH_TOKEN";
                    valueFrom.secretKeyRef = { name = cfg.agent.claudeCode.tokenSecret; key = "token"; };
                  }
                  # goose's claude-code provider invokes `claude … --dangerously-skip-permissions`,
                  # and the claude CLI REFUSES that flag when running as root ("cannot be used
                  # with root/sudo privileges") — which the agent-host container does — so claude
                  # exits instantly and goose reports "Claude CLI process terminated unexpectedly".
                  # IS_SANDBOX=1 tells claude it's in a sandboxed context, permitting the flag as
                  # root. (Proper long-term fix: run the agent-host as a non-root user.)
                  { name = "IS_SANDBOX"; value = "1"; }
                ] ++ lib.optional (!cfg.fakeAgent && defaultModelId != null)
                  # The default model. Derived from availableModels.<id>.default
                  # (or the deprecated agent.model).
                  { name = "GOOSE_MODEL"; value = defaultModelId; }
                ++ lib.optional (!cfg.fakeAgent && hasModels)
                  # The rich catalog (ids + hints + default) the agent-host reads.
                  # Powers list_models / switch_model + the per-conversation override.
                  { name = "AGENT_MODELS_JSON"; value = modelsJson; }
                ++ lib.optional cfg.fakeAgent
                  # Run the bundled dummy ACP agent (no model/cluster) — for the
                  # spawn-from-webhook + UI e2e on the cluster.
                  { name = "GOOSE_BIN"; value = "fake"; }
                ++ lib.optionals cfg.broker.aws.enable [
                  # AWS permissions broker: the agent-host mounts the account
                  # ConfigMap into each sandbox, and resolves approvals against the
                  # broker (BROKER_URL + the projected SA token).
                  { name = "AWS_ACCOUNTS_CONFIGMAP"; value = "agent-broker-aws-accounts"; }
                ] ++ lib.optionals (cfg.broker.aws.enable || cfg.sandboxViaBroker) [
                  # BROKER_URL + the projected broker token: needed by the AWS
                  # approve/deny relay AND by the sandbox-lifecycle broker client
                  # (SANDBOX_VIA_BROKER). Emit once under either flag so the two
                  # paths don't double-declare the same env keys.
                  { name = "BROKER_URL"; value = "http://agent-broker.${cfg.namespace}.svc.cluster.local:8080"; }
                  { name = "BROKER_TOKEN_PATH"; value = "/var/run/secrets/broker/token"; }
                ] ++ lib.optionals cfg.sandboxViaBroker [
                  # Control-plane move: route the sandbox LIFECYCLE through the broker
                  # (the agent-host's provisioner becomes an HTTP client). Gated so
                  # the default (legacy in-agent-host k8s provisioner) is unchanged.
                  { name = "SANDBOX_VIA_BROKER"; value = "1"; }
                ] ++ lib.optionals (cfg.deployTools.scooterConfigMap != null) [
                  # Deployment tool injection (generic): the agent-host mounts the
                  # deployment's .scooter ConfigMap + projects the named token
                  # audiences + sets the deployment env on each sandbox.
                  { name = "SCOOTER_CONFIGMAP"; value = cfg.deployTools.scooterConfigMap; }
                ] ++ lib.optional (cfg.deployTools.tokenAudiences != [ ])
                  { name = "SCOOTER_TOKEN_AUDIENCES"; value = lib.concatStringsSep "," cfg.deployTools.tokenAudiences; }
                ++ lib.optional (cfg.deployTools.env != { })
                  # JSON, not `k=v;k=v` — a value with a newline (a multi-line
                  # NIX_CONFIG), a `;`, or a `=` cannot survive the flat encoding
                  # (it splits/mangles, and the parser's trim() ate the newlines).
                  # toJSON round-trips every value losslessly into the pod env.
                  { name = "SCOOTER_ENV"; value = builtins.toJSON cfg.deployTools.env; }
                ++ lib.optional (cfg.deployTools.configFiles != { })
                  # The agent-host mounts this ConfigMap (filename -> contents) as a
                  # flat dir at /etc/agent-sandbox/config in each sandbox. File-based
                  # (not env) so multi-line config survives the CRD controller.
                  { name = "SCOOTER_CONFIG_FILES_CONFIGMAP"; value = "deploy-config-files"; }
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
                ++ lib.optional (cfg.broker.aws.enable || cfg.sandboxViaBroker)
                  # The agent-host's own broker token — used to relay AWS approve/deny
                  # AND (control-plane move) to authenticate to the broker's sandbox
                  # lifecycle API. Mounted under either flag.
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
              ++ lib.optional (cfg.broker.aws.enable || cfg.sandboxViaBroker)
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
      } // lib.optionalAttrs (cfg.deployTools.configFiles != { }) {
        # Deployment config FILES (filename -> contents), mounted as a flat dir at
        # /etc/agent-sandbox/config in each sandbox. File-based, so multi-line config
        # (e.g. a nix.conf) survives the sandbox CRD controller's env-var newline
        # corruption. The agent-host provisioner mounts it (SCOOTER_CONFIG_FILES_CONFIGMAP).
        deploy-config-files = {
          metadata = { name = "deploy-config-files"; namespace = cfg.namespace; };
          data = cfg.deployTools.configFiles;
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
              # A static file server — small footprint.
              resources = lib.mkDefault {
                requests = { cpu = "50m"; memory = "64Mi"; };
                limits = { memory = "256Mi"; };
              };
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
          rules = [(
            # Omit `host` entirely when unset — a host-less rule is a valid
            # catch-all (any Host), whereas `host: ""` is rejected by some
            # controllers. Set `ingress.host` for name-based routing.
            lib.optionalAttrs (cfg.ingress.host != "") { host = cfg.ingress.host; }
            // {
              http.paths = [{
                path = "/";
                pathType = "Prefix";
                backend.service = { name = ingressBackend; port.number = 8080; };
              }];
            }
          )];
          # Only emit a tls entry when there's a host to name — a hostless
          # default-on ingress (local/dev) carries no TLS block.
          tls = lib.optionals (cfg.ingress.tls && cfg.ingress.host != "") [
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
