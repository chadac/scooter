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

  # --- Model catalog: fold availableModels (PROVIDER-FIRST: provider -> model id -> opts) into
  # the rich list the agent-host reads as AGENT_MODELS_JSON. Model ids are provider-specific
  # namespaces (Bedrock ids via "goose"; API ids via "claude-code"/"byoc"), so the provider is
  # the natural OUTER key: a model offered by two providers is listed under both, and each
  # provider group marks its own default.
  providerNames = lib.attrNames cfg.agent.availableModels;
  # id -> the providers offering it.
  providersOf = id: lib.filter (p: cfg.agent.availableModels.${p} ? ${id}) providerNames;
  # provider -> its default model id (the entry flagged default, else the group's first).
  providerDefault = p:
    let ids = lib.attrNames cfg.agent.availableModels.${p};
        flagged = lib.findFirst (id: cfg.agent.availableModels.${p}.${id}.default) null ids;
    in if flagged != null then flagged else if ids != [ ] then lib.head ids else null;
  providerDefaults = lib.filterAttrs (_: v: v != null)
    (lib.genAttrs providerNames providerDefault);
  providerModelIds = lib.unique
    (lib.concatMap (p: lib.attrNames cfg.agent.availableModels.${p}) providerNames);
  # The GLOBAL default (provider-less contexts): the goose group's — the cloud floor is what a
  # provider-less context runs — else the deprecated agent.model, else the first model anywhere.
  defaultModelId =
    if providerDefaults ? goose then providerDefaults.goose
    else if cfg.agent.model != null then cfg.agent.model
    else if providerModelIds != [ ] then lib.head providerModelIds
    else null;
  modelIds = lib.unique (
    providerModelIds
    ++ lib.optional (cfg.agent.model != null && !(lib.elem cfg.agent.model providerModelIds)) cfg.agent.model
  );
  # A model's hint: the first provider group defining one.
  hintOf = id:
    let hints = lib.filter (h: h != "")
      (map (p: cfg.agent.availableModels.${p}.${id}.hint or "") (providersOf id));
    in if hints != [ ] then lib.head hints else "";
  modelsJson = builtins.toJSON (map (id: {
    inherit id;
    hint = hintOf id;
    default = id == defaultModelId;
    # A model from the deprecated flat `agent.model` has no tags = every provider.
    providers = providersOf id;
    # The providers this model is THE default for — the runtime's per-provider default.
    defaultFor = lib.filter (p: providerDefaults.${p} == id) (lib.attrNames providerDefaults);
  }) modelIds);
  hasModels = modelIds != [ ];

  # Platform skills, each paired with the capability it documents. A skill whose gate
  # is false is NOT shipped: the agent should not read instructions for a route that
  # 404s. Deployment `skills` win on a filename collision, so an operator can always
  # override one of ours.
  bcfg = config.agentSandbox.broker;
  gatedSkills = {
    "scooter-grafana.md" = bcfg.grafana.enable;
  };
  builtins' = lib.optionalAttrs cfg.agent.builtinSkills (
    lib.mapAttrs' (file: _: lib.nameValuePair file (builtins.readFile (./skills + "/${file}")))
      (lib.filterAttrs (_: gate: gate) gatedSkills)
  );
  allSkills = builtins' // cfg.agent.skills;
in
{
  # NOTE: ./testing.nix is deliberately NOT imported here. Test-only overrides (a dummy agent, an
  # unauthenticated test webhook) must be opted into by a TEST manifest, so a deploy that never
  # imports it cannot enable them by setting a stray boolean. See modules/testing.nix.
  imports = [ kubenix.modules.k8s ./postgres.nix ./db-migrate.nix ./broker.nix ./webhooks.nix ./byoc.nix ./scheduler.nix ./conversation-controller.nix ./warm-store-controller.nix ./legacy-state-migration.nix ./event-backfill.nix ];

  options.agentSandbox = with lib; {
    namespace = mkOption {
      type = types.str;
      default = "agent-sandbox";
      description = "Namespace for the platform + sandboxes.";
    };
    registryPrefix = mkOption {
      type = types.str;
      default = "ghcr.io/chadac/scooter/";
      example = "123456789012.dkr.ecr.us-east-1.amazonaws.com/myorg/";
      description = ''
        Registry/repository prefix prepended to the default image names
        (agent-host, agent-broker, agent-webhooks, agent-sandbox-os). Defaults to
        the published ghcr images (the publish-images workflow pushes them there).
        Set to "" for bare local names (`agent-host:latest`) when images are
        side-loaded (kind/k3s e2e), or to an ECR/registry prefix (WITH trailing
        slash) for another cluster. Per-image options below override this entirely.

        For a REPRODUCIBLE pin, override the per-image options with the content tags
        from `nix build .#ghcr-image-refs` instead of the floating :latest below.
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
    sandboxRuntimeClass = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "crun";
      description = ''
        RuntimeClass for the per-conversation sandbox pod (the systemd-PID-1 image).
        A cgroup-delegating runtime (e.g. crun) gives the sandbox's systemd a writable
        cgroup subtree in its OWN private cgroup namespace, so the sandbox runs
        NON-privileged. Leaving this null runs sandboxes privileged-equivalent under
        the cluster default runtime — which forces the HOST cgroup namespace and lets a
        booting sandbox churn the host /kubepods.slice tree (node instability; on a
        workstation node, a host-session logout). Set to a runtime present on the
        cluster (`kubectl get runtimeclass`).
      '';
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
      sandboxManifestOverlay = mkOption {
        type = types.attrsOf types.anything;
        default = { };
        example = {
          spec.podTemplate.spec = {
            nodeSelector."scooter.io/pool" = "sandbox";
            tolerations = [{ key = "sandbox"; operator = "Exists"; effect = "NoSchedule"; }];
            containers = [{
              name = "sandbox"; # strategic-merge by name onto Scooter's container
              env = [{ name = "MY_TOOL_URL"; value = "http://tool.ns.svc:8080"; }];
            }];
          };
        };
        description = ''
          A recursive PATCH deep-merged on top of the broker-generated per-conversation
          Sandbox manifest — so a deployment can change the pod manifest (nodeSelector,
          tolerations, extra env/volumes, annotations, resources, …) WITHOUT patching
          Scooter's code. Rendered to the ConfigMap `sandbox-manifest-overlay` (one key
          `overlay.yaml`) and read by the broker at conversation-create time.

          Merge semantics (see services/broker/broker/sandbox/overlay.py): dicts merge
          deep; scalars replace; LISTS strategic-merge by `name` (an env/volume/mount
          with a matching `name` is patched, others appended) — so you patch one
          container's env by restating just `{ name = "sandbox"; env = [ … ]; }`.

          The overlay may touch ANY path, but Scooter RE-ASSERTS a protected set after
          merge (serviceAccountName, the broker-token volume/mount, volumeClaimTemplates,
          and the CONVERSATION_ID / BROKER_* identity env), so a bad overlay can't detach
          a conversation from its identity, auth, or storage.
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
    statelessReplicas = mkOption {
      type = types.int;
      default = 2;
      description = ''
        Replica count for the STATELESS platform services — the broker, scheduler,
        webhooks, and UI. Defaults to 2 so a node drain / consolidation can't take a
        whole service down (one replica stays up while the other reschedules). These
        are safe to scale: state lives in the shared Postgres; the scheduler claims due
        tasks atomically (FOR UPDATE SKIP LOCKED, no double-fire); the broker's only
        in-memory state is a short-lived STS-credential cache that re-vends on a miss.
        NOT applied to agent-host (per-conversation, single-replica via `replicas` + a
        RWO state PVC) or openfga (its own store).
      '';
    };
    # INTERNAL. Set by modules/testing.nix, never by a deploy config. It exists as an option only
    # because the production env-var block below has to read it; the guard in that module is what
    # keeps a real deploy from turning it on. See modules/testing.nix for why this inverted.
    sandboxResources = mkOption {
      type = types.nullOr types.attrs;
      default = null;
      description = ''
        Resource requests/limits for each conversation's sandbox pod, as
        {requests = {cpu, memory}; limits = {cpu, memory};}. null = the agent-host
        default (Guaranteed QoS, 2 cpu / 4Gi — reserves the full amount per sandbox).
        Set smaller values on constrained clusters (CI runners) where reserving
        2 whole CPUs per sandbox makes a second concurrent sandbox unschedulable.
      '';
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
        type = types.attrsOf (types.attrsOf (types.submodule {
          options = {
            default = mkOption {
              type = types.bool;
              default = false;
              description = "This provider's default model (at most one per provider; else the group's first entry).";
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
            goose = {
              "us.anthropic.claude-sonnet-4-6" = { default = true; hint = "Fast + cheap."; };
              "us.anthropic.claude-opus-4-8" = { hint = "Slow + powerful."; };
            };
            byoc."claude-sonnet-4-5" = { default = true; hint = "The user's own subscription."; };
            claude-code."claude-sonnet-4-5" = { default = true; };
          }
        '';
        description = ''
          The model catalog, PROVIDER-FIRST: provider -> model id -> options.
          Model ids are provider-specific namespaces — "goose" runs Bedrock ids
          (us.anthropic.…) while "claude-code" (the in-cluster subscription SDK)
          and "byoc" (the user's own container) run API ids (claude-sonnet-4-5) —
          so the provider is the outer key: a model two providers offer is simply
          listed under both, and each provider group marks its own `default`. A
          run only ever receives a model its provider serves — the conversation's
          choice when that provider offers it, else that provider's default. The
          global default (provider-less contexts, e.g. the deprecated GOOSE_MODEL)
          comes from the "goose" group, falling back to the deprecated
          `agent.model`. The agent switches its own model via switch_model; the
          UI/management API can also override per-conversation. Rendered to the
          agent-host as AGENT_MODELS_JSON.
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
      # BRING-YOUR-OWN-CLAUDE (Increment 2): users run a container with THEIR Claude subscription
      # that dials in over a WS; scooter routes their human-triggered conversations to it.
      remoteAgent = {
        enable = mkOption {
          type = types.bool;
          default = cfg.byoc.enable;
          defaultText = literalExpression "config.agentSandbox.byoc.enable";
          description = ''
            Bring-your-own-Claude remote agents (the Settings UI + agent-host mint/status routes).
            Defaults to `byoc.enable`: the controller and the host-side routes are two halves of
            ONE feature — enabling the controller without these leaves a Settings page that 404s,
            and enabling these without the controller leaves a one-liner that dials nothing. One
            knob (`agentSandbox.byoc.enable = true`) turns on a working whole.
          '';
        };
        joinSecret = mkOption {
          type = types.str;
          default = "agent-remote-join-secret";
          description = ''
            Name of the Secret holding the HS256 signing key (key `secret`) the agent-host uses to
            sign + verify owner-bound join tokens. ONE server-side key (not per-user). Wired to
            REMOTE_AGENT_JOIN_SECRET when remoteAgent.enable = true. Create out-of-band:
            kubectl create secret generic <name> --from-literal=secret=$(openssl rand -hex 32).
          '';
        };
        image = mkOption {
          type = types.str;
          # ghcr.io/<owner>/scooter/<image> is the path scheme publish-images.yml pushes;
          # the old ghcr.io/chadac/scooter-remote-agent ref matched nothing that workflow
          # could ever produce, so the Settings one-liner failed `docker pull` for everyone.
          default = "ghcr.io/chadac/scooter/remote-agent:latest";
          description = "The ghcr container image the Settings one-liner tells users to `docker run` (REMOTE_AGENT_IMAGE).";
        };
        bridgeUrl = mkOption {
          type = types.str;
          default =
            let bi = cfg.byoc.ingress; in
            if cfg.byoc.enable && bi.enable && bi.host != ""
            then "${if bi.tls then "https" else "http"}://${bi.host}"
            else "";
          defaultText = literalExpression ''"https://''${byoc.ingress.host}" when the BYOC ingress is enabled'';
          example = "https://byoc.example.com";
          description = ''
            PUBLIC base URL of the BYOC controller's ingress — what the user's container dials
            (`/byoc/ws/<session-id>` is appended per owner). DERIVED from
            `byoc.ingress.{host,tls}` by default — the module already knows this URL, so asking
            deployers to restate it was a copy-paste invariant waiting to drift. Override only
            when the public URL is not the ingress host (an external LB/CDN in front). Empty ⇒
            the Settings one-liner shows a placeholder host.
          '';
        };
      };
      name = mkOption {
        type = types.str;
        default = "Scooter";
        description = "Display name the agent goes by (AGENT_NAME) — its identity in the UI + prompt.";
      };
      # Skills the platform SHIPS, each gated on the capability it documents. A skill
      # for a service that is not wired teaches the agent to attempt something that
      # 404s, then to misread that 404 as the feature being broken — which is exactly
      # how the grafana skill sent an agent chasing a `loki/` path that never existed.
      builtinSkills = mkOption {
        type = types.bool;
        default = true;
        description = ''
          Ship the platform's own skills, each only when the capability it documents
          is enabled (e.g. scooter-grafana only with broker.grafana.enable). Set false
          to supply every skill yourself via `skills`.
        '';
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

    retentionMaxAgeMs = mkOption {
      type = types.int;
      default = 0;
      description = ''
        Retention reap: DESTROY (end — pod + PVCs + record) an UNSTARRED
        conversation that has been inactive (no prompt/event) longer than this.
        Age is measured from last activity, so a recently-used conversation is
        never reaped however old it is. STARRED conversations are exempt. 0
        disables (the default — opt in for a real deployment, e.g. 30 days =
        2592000000). Runs on a slow cadence (retentionSweepIntervalMs, default 6h).
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
      # BROWSER telemetry (RUM). Separate from `otel` below, which is the
      # agent-host's own metrics: this is the UI, running in the user's browser,
      # pushing OTLP over the same origin. It exists because the failures that
      # matter most in a chat UI — a render stream reconnecting to the wrong
      # conversation, a runtime remounting mid-run — happen entirely client-side
      # and never reach a pod log.
      browserTelemetry = {
        enable = mkOption {
          type = types.bool;
          default = false;
          description = ''
            Let the UI send OTLP traces to a collector, proxied same-origin
            through the UI's nginx at /telemetry/. OFF by default.

            Same-origin on purpose: the browser holds no telemetry credential and
            the traffic stays behind the ingress auth, so changing vendor
            (Grafana Cloud, Datadog, ...) is a collectorUrl change rather than a
            UI rebuild. Requires collectorUrl to be set.
          '';
        };
        collectorUrl = mkOption {
          type = types.nullOr types.str;
          default = null;
          example = "http://alloy-singleton.monitoring.svc.cluster.local:4318";
          description = ''
            OTLP/HTTP base URL of the collector that receives browser telemetry.
            HTTP, not gRPC — browsers cannot speak OTLP/gRPC.

            NO DEFAULT, deliberately. A plausible-looking default would point
            telemetry at an address that probably does not exist in THIS cluster,
            and the failure would be silent: spans collected, posted, discarded.
            Enabling browserTelemetry without setting this is an eval error (see
            the assertion below), not a running system that quietly drops data.

            With the Grafana k8s-monitoring chart this is the alloy-singleton
            Service on port 4318, once
            `applicationObservability.receivers.otlp.http` is enabled — verified
            against the chart's rendered output, not guessed.
          '';
        };
        sampleRatio = mkOption {
          type = types.float;
          default = 1.0;
          description = ''
            Fraction of browser traces to record (0.0-1.0). 1.0 while debugging;
            lower it if the UI's live event stream produces more spans than the
            collector should carry.
          '';
        };
      };

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
    # The agent_host database: the tables agent-host OWNS (conversation_jobs). The
    # provisioning Job creates the db + an `agent_host` role that owns it, and writes the
    # password to `agent-pg-agent-host`.
    agentSandbox.postgres.consumers.agent-host = { db = "agent_host"; user = "agent_host"; };

    # The conversation-router gets READ-ONLY access so it can serve the durable conversation
    # list itself instead of fanning out to every agent-host pod. Its `conversation_router` role
    # owns nothing — granted SELECT on EXACTLY the tables the list reads, nothing else (notably
    # NOT conversation_events, the transcripts), and pinned read-only at the server.
    #
    # The table set is DERIVED from lib/sql/owners.toml (the ownership manifest), not repeated
    # here: whichever tables list "conversation-router" in their readers ARE its grants. So the
    # manifest is the single reviewable source of truth and the grant cannot drift from it —
    # adding a table for the router is one line in owners.toml. Secret: agent-pg-conversation-router.
    agentSandbox.postgres.readers.conversation-router =
      let
        manifest = builtins.fromTOML (builtins.readFile ../lib/sql/owners.toml);
        # Tables in `db` whose readers list includes conversation-router.
        tablesFor = db: lib.attrNames (lib.filterAttrs
          (_t: rule: builtins.elem "conversation-router" (rule.readers or [ ]))
          (manifest.${db}.tables or { }));
      in
      {
        user = "conversation_router";
        grants = [
          { db = "agent_host"; tables = tablesFor "agent_host"; }
        ] ++ lib.optional cfg.webhooks.enable { db = "webhooks"; tables = tablesFor "webhooks"; };
      };

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
              # configmaps: destroy() reaps the legacy per-conversation module ConfigMap
              # that older clusters still carry. Drop the verb once none remain.
              resources = [ "serviceaccounts" "persistentvolumeclaims" "pods" "configmaps" ];
              verbs = [ "get" "list" "watch" "create" "update" "patch" "delete" ];
            }
            execRule
            {
              # Multi-replica: the agent-host WATCHES Conversations (ownershipGuard fencing)
              # and CREATES one per new conversation (conversationRegistry) so the controller
              # can assign it a hostPod.
              #
              # PATCH is needed because the router now creates the CR (POST /conversations)
              # WITHOUT a sandboxRef — it does not provision. The host owns that field, and
              # the router derives its routing short-id from it, so the host must merge-patch
              # spec.sandboxRef onto an already-existing CR. Without this verb that patch
              # 403s silently (fire-and-forget) and the conversation stays unroutable.
              apiGroups = [ "scooter.chadac.dev" ];
              resources = [ "conversations" ];
              # DELETE: ending a conversation must remove its CR. The CR is the source of
              # truth for existence, so without this a deleted conversation is re-adopted by
              # hydrate() and comes back — DELETE answered 204 while the conversation stayed
              # listed as `running` forever, and the 403 was invisible until remove() logged it.
              verbs = [ "get" "list" "watch" "create" "patch" "delete" ];
            }
            {
              # The agent-host PUBLISHES liveness to status.phase (Assigned on
              # revive/resume, Suspended on idle-suspend) via conversationRegistry.setPhase
              # — owner-fenced, so only the hosting pod writes. WITHOUT this the setPhase
              # PATCH 403s silently (fire-and-forget), the phase never reaches Suspended, and
              # the autoscaler counts the conversation as demand forever → the fleet never
              # sleeps. (The controller ALSO patches status for assignment; both are writers,
              # coordinated by ownership-fencing + phase semantics.) status is its OWN
              # subresource RBAC-wise, hence a separate rule.
              apiGroups = [ "scooter.chadac.dev" ];
              resources = [ "conversations/status" ];
              verbs = [ "get" "patch" "update" ];
            }
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

      # agent-host is a StatefulSet (not a Deployment) so each replica has a STABLE
      # ordinal name + per-pod DNS (agent-host-<n>.agent-host-headless.<ns>.svc) — the
      # address the conversation-router forwards to for the pod that owns a conversation
      # (status.hostPod). At replicas=1 this behaves exactly like the old single-replica
      # Deployment: one pod, one shared state PVC. A StatefulSet's RollingUpdate also
      # terminates the old ordinal pod BEFORE creating its replacement, so the shared
      # RWO agent-host-state volume is never Multi-Attach-deadlocked (the reason the
      # Deployment needed Recreate) — RollingUpdate is safe here.
      #
      # DESIGN (rollout-drain, todo/docs/ROLLOUT_DRAIN_AND_POD_IP.md) — NOT YET APPLIED:
      # convert this StatefulSet → a Deployment for seamless upgrades:
      #   - deployments.agent-host (random pod names — routing is by POD IP now, not DNS).
      #   - strategy RollingUpdate maxSurge=1, maxUnavailable=0 (new pod Ready BEFORE the old
      #     drains → no capacity gap; terminate-before-create was ONLY forced by the RWO PVC).
      #   - per-pod `state` volumeClaimTemplate → emptyDir (it's a HOT CACHE; the durable copy
      #     is the shared RWX history mirror ⇒ no RWO PVC ⇒ no Multi-Attach blocker).
      #   - REMOVE services.agent-host-headless (no per-pod DNS); keep the `agent-host`
      #     ClusterIP Service (the router's fallback target).
      # SEAMLESS ROLLOUT (todo/docs/ROLLOUT_DRAIN_AND_POD_IP.md): a Deployment with
      # maxSurge=1/maxUnavailable=0 — a new-gen pod becomes Ready BEFORE any old pod drains,
      # so capacity never dips during an upgrade (the StatefulSet's terminate-before-create,
      # forced by the RWO PVC's Multi-Attach, was what caused the gap). Routing is by POD IP
      # now (status.hostIP), so random Deployment pod names are fine — no ordinal/DNS needed.
      # The per-pod `state` volume is an emptyDir HOT CACHE: durable history lives on the
      # shared RWX mirror (MIRROR_STATE_PATH), and a reassigned conversation is revived from
      # it (controller revive-push). No RWO PVC ⇒ no Multi-Attach ⇒ surge is safe.
      deployments.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        # When the controller autoscales the agent-host, it is the SINGLE writer of
        # spec.replicas — so OMIT replicas from the manifest (a re-apply that set it would
        # fight the autoscaler, resetting the fleet to a fixed count each deploy). k8s keeps
        # the controller-set value on apply when the field is absent. The autoscaler's
        # minReplicas is the effective floor (+ its initial scale-up on first tick). When
        # autoscale is OFF, pin the fixed count as before. (lib.optionalAttrs, NOT mkIf: this is
        # a kubenix RESOURCE attrset, not a module option — mkIf would pass through unmerged.)
        spec = (lib.optionalAttrs (!cfg.conversationController.autoscale) {
          replicas = cfg.conversationController.agentHostReplicas;
        }) // {
          strategy = {
            type = "RollingUpdate";
            rollingUpdate = { maxSurge = 1; maxUnavailable = 0; };
          };
          selector.matchLabels.app = "agent-host";
          template = {
            metadata.labels.app = "agent-host";
            spec = {
              serviceAccountName = "agent-host";
              # fsGroup 0 (root group) so the agent-host process — running as root — can write
              # its scratch/state dirs. (Kept from the PVC era; harmless with emptyDir.)
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
                # Memory scales with ACTIVE conversations, not with the process: each one
                # holds its hydrated event log and spawns an agent CLI with its own heap
                # (measured ~190 MiB per active conversation; a replica with four sat at
                # 784 MiB). At 1 GiB a fifth conversation OOM-killed the pod, and a
                # restart re-resumed every dangling run at once and killed it again.
                # 2 GiB covers the ~5 conversations a replica hosts, with the request at
                # half so the scheduler packs on steady state rather than on the burst.
                resources = lib.mkDefault {
                  requests = { cpu = "250m"; memory = "1Gi"; };
                  limits = { memory = "2Gi"; };
                };
                ports = [{ containerPort = 8080; name = "agui"; }];
                env = [
                  { name = "PORT"; value = "8080"; }
                  { name = "NAMESPACE"; value = cfg.namespace; }
                  # This pod's own name (downward API) — its identity for the
                  # Conversation CRD hostPod + generation-fencing (multi-replica). Set
                  # unconditionally (harmless single-replica); the StatefulSet gives it
                  # the stable ordinal name (agent-host-<n>).
                  { name = "POD_NAME"; valueFrom.fieldRef.fieldPath = "metadata.name"; }
                  { name = "SANDBOX_IMAGE"; value = cfg.sandboxImage; }
                  # imagePullPolicy for the per-conversation sandbox pods — mirror the
                  # platform pullPolicy (IfNotPresent for side-loaded kind/k3s, Always
                  # for a registry). Without this the provisioner defaults to "Always",
                  # which fails ImagePullBackOff on a local cluster with no registry.
                  { name = "SANDBOX_PULL_POLICY"; value = cfg.pullPolicy; }
                  # The trusted SA(s) the agent-host lets set a conversation `owner`
                  # on /agui (verified via TokenReview) — COMMA-SEPARATED. The webhooks
                  # service always; the scheduler too when enabled (both spawn
                  # owner-set conversations). Unset = owner never honored.
                  { name = "WEBHOOKS_SERVICE_ACCOUNT";
                    value = lib.concatStringsSep "," (
                      [ "system:serviceaccount:${cfg.namespace}:agent-webhooks" ]
                      ++ lib.optional cfg.scheduler.enable "system:serviceaccount:${cfg.namespace}:agent-scheduler"
                    ); }
                  # Durable: the AG-UI event log (history) on the per-pod PVC.
                  # EPHEMERAL cache (emptyDir), not the durable record — see
                  # docs/CONVERSATION_STATE_MODEL.md.
                  { name = "LOCAL_STATE_PATH"; value = "/var/lib/agent-host/conversations"; }
                  # Ephemeral scratch (emptyDir): goose's per-conversation cwd +
                  # $HOME (sessions DB + .goosehints). The agent's real work execs
                  # into the SANDBOX, so none of this is durable — keeping it off
                  # the PVC avoids the SELinux/fsGroup subdir-context problems an
                  # EBS volume hits, and the image's "/" default is unwritable.
                  { name = "SCRATCH_PATH"; value = "/var/lib/agent-scratch"; }
                  { name = "HOME"; value = "/var/lib/agent-scratch/home"; }
                  { name = "IDLE_SUSPEND_MS"; value = toString cfg.idleSuspendMs; }
                ]
                ++ lib.optional cfg.conversationController.assets.enable
                  { name = "ASSETS_PATH"; value = "/var/lib/agent-assets"; }
                ++ lib.optional cfg.byoc.traceTunnel
                  # Per-frame tracing of the BYOC MCP tunnel (method, direction, bytes,
                  # status, correlated by stream). Off by default — it is per-frame and
                  # would drown a normal log — but the whole exchange in one run is the
                  # difference between reading a bug and guessing at it.
                  { name = "TUNNEL_TRACE"; value = "1"; }
                ++ [
                ]
                ++ lib.optional (cfg.sandboxRuntimeClass != null)
                  # RuntimeClass for the sandbox pod (e.g. crun) — a cgroup-delegating
                  # runtime so the sandbox's systemd PID 1 runs NON-privileged in its
                  # own private cgroup namespace (privileged forces the host cgroup ns
                  # → the sandbox churns the host /kubepods.slice tree → node instability
                  # / host logout). Unset ⇒ cluster default runtime.
                  { name = "SANDBOX_RUNTIME_CLASS"; value = cfg.sandboxRuntimeClass; }
                ++ lib.optional (cfg.retentionMaxAgeMs > 0)
                  # Auto-delete unstarred conversations inactive past the window
                  # (0/default = off, so absent unless a deployment opts in).
                  { name = "RETENTION_MAX_AGE_MS"; value = toString cfg.retentionMaxAgeMs; }
                ++ [
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
                ++ lib.optionals cfg.scheduler.enable ([
                  # Scheduled-task MCP tools (list/search/view/create/edit/delete): the
                  # agent-host proxies to the scheduler service, scoped to the
                  # conversation owner. Only wired when the scheduler is deployed.
                  { name = "SCHEDULER_URL"; value = "http://agent-scheduler.${cfg.namespace}.svc.cluster.local:8080"; }
                ] ++ lib.optional (cfg.scheduler.relayKey != "")
                    { name = "SCHEDULER_RELAY_KEY"; value = cfg.scheduler.relayKey; })
                ++ lib.optional (!cfg.fakeAgent)
                  # Real `goose acp`. The provider selects the model backend.
                  { name = "GOOSE_PROVIDER"; value = cfg.agent.provider; }
                ++ lib.optionals (!cfg.fakeAgent && cfg.agent.provider != "claude-code") [
                  # Bedrock (or another AWS-backed provider): the agent process inherits
                  # the pod's IRSA identity via the AWS SDK web-identity chain — no keys.
                  { name = "AWS_REGION"; value = cfg.agent.region; }
                  { name = "AWS_DEFAULT_REGION"; value = cfg.agent.region; }
                ] ++ lib.optionals (!cfg.fakeAgent && cfg.agent.provider == "claude-code") [
                  # claude-code provider: the agent-host drives the agent via the Claude
                  # Agent SDK (services/claude-sdk-provider, baked in) instead of goose —
                  # so the agent's shell/file tools run IN THE SANDBOX (an in-process MCP
                  # server → ExecBackend), fixing the "tools ran in the agent-host pod,
                  # scooter-rebuild unreachable" bug. GOOSE_PROVIDER=claude-code (set above)
                  # selects that branch. Auth is the long-lived subscription OAuth token
                  # (`claude setup-token`) from a Secret; the SDK reads CLAUDE_CODE_OAUTH_TOKEN.
                  {
                    name = "CLAUDE_CODE_OAUTH_TOKEN";
                    valueFrom.secretKeyRef = { name = cfg.agent.claudeCode.tokenSecret; key = "token"; };
                  }
                  # The SDK bundles a musl `claude` that fails on the glibc image;
                  # point it at the glibc `claude` baked onto the image (nixpkgs
                  # claude-code, on PATH) via pathToClaudeCodeExecutable.
                  { name = "CLAUDE_CODE_COMMAND"; value = "claude"; }
                  # The SDK spawns the bundled `claude` CLI, which uses
                  # `--dangerously-skip-permissions`; that flag is refused under root (the
                  # agent-host runs as root) unless IS_SANDBOX marks a sandboxed context.
                  # (Proper long-term fix: run the agent-host as a non-root user.)
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
                ++ lib.optional (cfg.sandboxResources != null)
                  # Per-sandbox pod sizing (JSON) — see the sandboxResources option.
                  { name = "SANDBOX_RESOURCES"; value = builtins.toJSON cfg.sandboxResources; }
                ++ lib.optionals cfg.agent.remoteAgent.enable [
                  # Bring-your-own-Claude: enable /remote-agent/connect + the Settings section.
                  # The HS256 signing key for owner-bound join tokens (one server-side secret).
                  {
                    name = "REMOTE_AGENT_JOIN_SECRET";
                    valueFrom.secretKeyRef = { name = cfg.agent.remoteAgent.joinSecret; key = "secret"; };
                  }
                  # The ghcr image the Settings one-liner references.
                  { name = "REMOTE_AGENT_IMAGE"; value = cfg.agent.remoteAgent.image; }
                ]
                ++ lib.optional (cfg.agent.remoteAgent.enable && cfg.agent.remoteAgent.bridgeUrl != "")
                  # The BYOC controller's PUBLIC base — what the container dials from the user's
                  # laptop (/byoc/ws/<session-id> is appended per owner).
                  { name = "BYOC_PUBLIC_URL"; value = cfg.agent.remoteAgent.bridgeUrl; }
                ++ lib.optional cfg.byoc.enable
                  # The controller's IN-CLUSTER base — where the agent-host mints sessions, resolves
                  # ownership, and sends every ACP frame. Without this there is NO BYO path and every
                  # run takes the cloud floor.
                  { name = "BYOC_CONTROLLER_URL"; value = "http://byoc-controller.${cfg.namespace}.svc.cluster.local:8080"; }
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
                ++ lib.optionals cfg.webhooks.enable ([
                  # READ access to the webhooks conversation_map + identity store (the
                  # shared Postgres `webhooks` db). Powers the agent-tools' target
                  # DISCOVERY fallback AND the settings Users page (identity store).
                  # Uses the webhooks role's own secret (agent-pg-webhooks). Present
                  # whenever webhooks is enabled — its db is always provisioned then.
                  { name = "WEBHOOKS_DB_HOST"; value = cfg.postgres.host; }
                  { name = "WEBHOOKS_DB_PORT"; value = toString cfg.postgres.port; }
                  { name = "WEBHOOKS_DB_NAME"; value = "webhooks"; }
                  { name = "WEBHOOKS_DB_USER"; value = "webhooks"; }
                  { name = "WEBHOOKS_DB_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-webhooks"; key = "password"; }; }
                ] ++ lib.optional (cfg.postgres.sslmode != null) { name = "WEBHOOKS_DB_SSLMODE"; value = cfg.postgres.sslmode; })
                # The BYOC database: agent-host writes byoc.remote_agents (the liveness
                # badge) alongside byoc-controller, which owns session_id. Gated on BYOC
                # being enabled — NOT on webhooks: agent-host's own tables must not vanish
                # because an unrelated service is off (the failure this whole chain fixes).
                ++ lib.optionals cfg.byoc.enable ([
                  { name = "BYOC_DB_HOST"; value = cfg.postgres.host; }
                  { name = "BYOC_DB_PORT"; value = toString cfg.postgres.port; }
                  { name = "BYOC_DB_NAME"; value = "byoc"; }
                  { name = "BYOC_DB_USER"; value = "byoc"; }
                  { name = "BYOC_DB_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-byoc"; key = "password"; }; }
                ] ++ lib.optional (cfg.postgres.sslmode != null) { name = "BYOC_DB_SSLMODE"; value = cfg.postgres.sslmode; })
                # The agent_host database: the tables agent-host OWNS (conversation_jobs,
                # conversations). Wired whenever Postgres is configured — NOT behind
                # another service's enable flag, or agent-host's own state disappears when
                # that service is off. See todo/draft/SHARED_DB_TABLE_OWNERSHIP.md.
                ++ [
                  { name = "AGENT_HOST_DB_HOST"; value = cfg.postgres.host; }
                  { name = "AGENT_HOST_DB_PORT"; value = toString cfg.postgres.port; }
                  { name = "AGENT_HOST_DB_NAME"; value = "agent_host"; }
                  { name = "AGENT_HOST_DB_USER"; value = "agent_host"; }
                  { name = "AGENT_HOST_DB_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-agent-host"; key = "password"; }; }
                ] ++ lib.optional (cfg.postgres.sslmode != null) { name = "AGENT_HOST_DB_SSLMODE"; value = cfg.postgres.sslmode; };
                volumeMounts = [
                  # Per-pod hot history (RWO volumeClaimTemplate).
                  { name = "state"; mountPath = "/var/lib/agent-host"; }
                  # Ephemeral agent scratch (emptyDir): goose cwd + $HOME.
                  { name = "scratch"; mountPath = "/var/lib/agent-scratch"; }
                  # The image's /tmp is read-only (nix store). goose needs a
                  # writable /tmp for session/new temp files — mount one.
                  { name = "tmp"; mountPath = "/tmp"; }
                ]
                ++ lib.optional cfg.conversationController.assets.enable
                  { name = "assets"; mountPath = "/var/lib/agent-assets"; }
                ++ lib.optional (cfg.agent.skills != { })
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
                # Graceful drain on rollout. preStop sleeps briefly so the Service
                # stops routing NEW traffic to this pod (endpoint removal propagates)
                # BEFORE the kubelet sends SIGTERM; the app's SIGTERM handler then
                # flushes in-flight event-log writes + closes SSE cleanly (clients get
                # a proper close + reconnect, not a raw 502 from a hard kill). Under
                # today's Recreate + replicas:1 this slightly lengthens the rollout gap
                # (accepted — the clean drain is the reusable primitive; once #123 moves
                # agent-host to a RollingUpdate StatefulSet the drain removes the gap
                # entirely). grace period bounds the whole stop; keep it > preStop +
                # SHUTDOWN_TIMEOUT_MS (8s) so the drain can finish.
                lifecycle.preStop.exec.command = [ "sleep" "5" ];
              };
              terminationGracePeriodSeconds = 20;
              # `state` is an emptyDir HOT CACHE (not a PVC): the durable copy is the shared
              # RWX history mirror, and a reassigned conversation is revived from it. Using an
              # emptyDir (no RWO PVC) is what lets the Deployment surge (maxSurge=1) without a
              # Multi-Attach deadlock. scratch/tmp are also ephemeral emptyDirs.
              volumes = [
                { name = "state"; emptyDir = { }; }
                { name = "scratch"; emptyDir = { }; }
                { name = "tmp"; emptyDir = { }; }
              ]
              ++ lib.optional cfg.conversationController.assets.enable
                  { name = "assets"; persistentVolumeClaim.claimName = "agent-host-assets"; }
              ++ lib.optional (cfg.agent.skills != { })
                { name = "skills"; configMap.name = "agent-skills"; }
              ++ lib.optional (cfg.observability.otel.enable && cfg.observability.otel.pricing != { })
                { name = "pricing"; configMap.name = "agent-pricing"; }
              ++ lib.optional (cfg.broker.aws.enable || cfg.sandboxViaBroker)
                { name = "broker-token"; projected.sources = [{ serviceAccountToken = { audience = "agent-broker"; path = "token"; }; }]; };
            };
          };
        };
      };


      # Agent skills (filename -> markdown), injected per conversation as
      # .goosehints. Edit this (the option) to add/change a skill — no image
      # rebuild. Only rendered when skills are configured.
      configMaps = lib.optionalAttrs (allSkills != { }) {
        agent-skills = {
          metadata = { name = "agent-skills"; namespace = cfg.namespace; };
          data = allSkills;
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
      } // lib.optionalAttrs (cfg.deployTools.sandboxManifestOverlay != { }) {
        # Consumer manifest overlay (a recursive PATCH deep-merged onto the generated
        # per-conversation Sandbox — see services/broker/broker/sandbox/overlay.py). The
        # broker reads this by name (SANDBOX_MANIFEST_OVERLAY_CONFIGMAP) at create time,
        # so a ConfigMap edit takes effect on the next conversation without a redeploy.
        sandbox-manifest-overlay = {
          metadata = { name = "sandbox-manifest-overlay"; namespace = cfg.namespace; };
          # One key holding the whole patch as YAML (JSON is valid YAML).
          data."overlay.yaml" = builtins.toJSON cfg.deployTools.sandboxManifestOverlay;
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

      # The `agent-host` Service — the public front door every caller uses
      # (agent-host.<ns>.svc:8080). Selects the ROUTER, which reverse-proxies each request to
      # the pod owning the conversation (status.hostIP). Callers (UI/broker/webhooks) are
      # unchanged.
      services.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        spec = {
          selector.app = "conversation-router";  # the front door always fronts the router
          ports = [{ port = 8080; targetPort = "agui"; name = "agui"; }];
        };
      };
      # ClusterIP Service selecting the agent-host PODS directly — the ROUTER'S FALLBACK
      # target (AGENT_HOST_SERVICE) for non-scoped / unassigned / stale-IP requests: k8s
      # load-balances to any ready pod. (Replaces the per-pod headless Service — routing is
      # by pod IP now, so no per-pod DNS is needed; this is just the "any ready pod" door.)
      services.agent-host-pods = {
        metadata = { name = "agent-host-pods"; namespace = cfg.namespace; };
        spec = {
          selector.app = "agent-host";
          ports = [{ port = 8080; targetPort = "agui"; name = "agui"; }];
        };
      };
    }
    # The PVC is provisioned when the mirror is IN USE, or when it is being kept
    # alive purely so the Postgres migration can read history out of it.
    (lib.mkIf (cfg.conversationController.historyMirror.enable
               || cfg.conversationController.historyMirror.retainForMigration) (
      let hm = cfg.conversationController.historyMirror; in {
        # Shared history-mirror PVC — ONE ReadWriteMany volume every agent-host
        # pod appends its events to (async, off the hot path). After a
        # conversation reassigns to a different pod, the new host reads its
        # history back from here. This is what makes cross-pod revival work; the
        # per-pod `state` volumeClaimTemplate is only each pod's local hot copy.
        persistentVolumeClaims.agent-host-history = {
          metadata = { name = "agent-host-history"; namespace = cfg.namespace; };
          spec = {
            accessModes = [ hm.accessMode ];
            resources.requests.storage = hm.size;
          }
          # hostPath escape hatch → bind to the
          # explicit PV below by class; otherwise use the given/ default class.
          // (if hm.hostPath != null
              then { storageClassName = "agent-host-history-hostpath"; }
              else lib.optionalAttrs (hm.storageClassName != null) { storageClassName = hm.storageClassName; });
        };
      }
      # Single-node hostPath PV so a ReadWriteMany PVC binds where there's no RWX
      # provisioner (all agent-host pods land on the one node, sharing the dir).
      // lib.optionalAttrs (hm.hostPath != null) {
        persistentVolumes.agent-host-history = {
          metadata.name = "agent-host-history";
          spec = {
            capacity.storage = hm.size;
            accessModes = [ hm.accessMode ];
            storageClassName = "agent-host-history-hostpath";
            persistentVolumeReclaimPolicy = "Retain";
            hostPath = { path = hm.hostPath; type = "DirectoryOrCreate"; };
          };
        };
      }
    ))
    (lib.mkIf cfg.conversationController.assets.enable {
      # Dedicated assets PVC for uploaded images. BYTES-ONLY: asset metadata
      # (conversation_id, asset_id, mime_type, size, sha256_hash, created_at) lives
      # in Postgres; the PVC holds only the raw image data, keyed by asset_id.
      # ReadWriteMany: all agent-host replicas write to the shared assets storage.
      persistentVolumeClaims.agent-host-assets = {
        metadata = { name = "agent-host-assets"; namespace = cfg.namespace; };
        spec = {
          accessModes = [ "ReadWriteMany" ];
          resources.requests.storage = cfg.conversationController.assets.size;
        }
        // lib.optionalAttrs (cfg.conversationController.assets.storageClassName != null) {
          storageClassName = cfg.conversationController.assets.storageClassName;
        };
      };
    })
    (lib.mkIf cfg.ui.enable {
      # Conversation UI — nginx serving the assistant-ui build and proxying the
      # agent-host API on the same origin (so the browser's /agui SSE + /sessions
      # + management calls work without CORS).
      deployments.ui = {
        metadata = { name = "ui"; namespace = cfg.namespace; };
        spec = {
          # Stateless static nginx (+ agent-host proxy) — 2 replicas by default so
          # consolidation can't take the UI offline.
          replicas = cfg.statelessReplicas;
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
              }] ++ lib.optionals cfg.observability.browserTelemetry.enable [
                # Where nginx forwards /telemetry/. ASSERT rather than defaulting to a
                # plausible-looking address: a wrong collector URL fails SILENTLY — the UI
                # collects spans, posts them, and nginx's 204 sink swallows the result, so
                # the deployment looks healthy while producing no telemetry at all. Fail
                # at eval instead.
                (assert lib.assertMsg (cfg.observability.browserTelemetry.collectorUrl != null)
                  "agentSandbox.observability.browserTelemetry.enable = true requires observability.browserTelemetry.collectorUrl to be set (e.g. http://alloy-singleton.monitoring.svc.cluster.local:4318 for the Grafana k8s-monitoring chart). There is no safe default: a wrong collector URL discards telemetry silently.";
                  {
                    name = "OTEL_COLLECTOR_URL";
                    value = cfg.observability.browserTelemetry.collectorUrl;
                  })
              ];
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
