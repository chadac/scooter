# Platform manifests: the long-lived deployment of the agent-host, its RBAC, the
# UI, the ingress, and the services the other modules contribute. The
# agent-sandbox controller and CRDs are installed separately, and per-conversation
# Sandboxes are created at runtime by the agent-host (see modules/conversation.nix).

{ kubenix, config, options, lib, ... }:

let
  cfg = config.scooter;

  # Every contrib's declaration and deployment half, imported whether or not it is
  # enabled, since `enable` only gates what ships.
  contribDecls = lib.filter (p: lib.hasSuffix "/contrib.nix" (toString p))
    (import ../contrib/all-modules.nix).imports;
  contribModules = [ ../contrib/all-modules.nix ]
    ++ lib.filter builtins.pathExists
      (map (p: builtins.dirOf p + "/deployment.nix") contribDecls);

  # Configuring an unshipped contrib fails the render, where a deployer-set field is
  # one outside the shared spec that differs from a registry-only eval (spec fields
  # such as src, ui and skills are not caught).
  specFields = lib.attrNames (lib.evalModules {
    specialArgs = { inherit lib; name = "schema"; };
    modules = [ ../contrib/submodule.nix ];
  }).options;
  # Baseline: the registry with no deployment config.
  bareContribs = (lib.evalModules {
    specialArgs = { inherit lib; };
    modules = [ ../contrib/all-modules.nix ];
  }).config.contribs;
  # tryEval both sides: a defaultless option throws when read.
  fieldVal = tree: n: f:
    let r = builtins.tryEval (builtins.deepSeq (tree.${n}.${f} or null) (tree.${n}.${f} or null));
    in if r.success then { ok = r.value; } else null;
  # name -> the deployment options a deployer actually set on it.
  deployerSet = n: lib.filter (f: fieldVal config.contribs n f != fieldVal bareContribs n f)
    (lib.subtractLists specFields (lib.attrNames config.contribs.${n}));
  unshippedConfigured = lib.filter (n: deployerSet n != [ ])
    (lib.attrNames (lib.filterAttrs (_: c: !c.enable) config.contribs));
  # A `throw` forced from the same leaf as `legacyRoot`, for the same reasons.
  shipGate = v:
    if unshippedConfigured == [ ] then v
    else throw ''
      This config sets options for contribs this build does not ship:

      ${lib.concatMapStringsSep "\n      " (n:
        "${n}: ${lib.concatMapStringsSep ", " (f: "contribs.${n}.${f}") (deployerSet n)}")
        unshippedConfigured}

      Each has `contribs.<name>.enable = false`, so no image contains it and the
      options above would render into a deployment that cannot serve them.

      Either drop the config, or ship the contrib by layering a module that enables it
      (`contribs.<name>.enable = lib.mkForce true`) onto the same eval — the shape
      `contrib/default.nix`'s `withModules` and the sandbox checks already use.
    '';

  # Guard for the removed `agentSandbox.*` root, forced from the namespace name
  # every render produces (a `throw`, since kubenix has no `assertions` option).
  legacyRoot = v:
    if !options.agentSandbox.isDefined then v
    else throw ''
      This config defines `agentSandbox.*` (in ${lib.concatStringsSep ", " options.agentSandbox.files}),
      which no longer exists: the platform's option root is now `scooter.*` (#710).

      It is a prefix swap and nothing else moved — `agentSandbox.broker.enable`
      is `scooter.broker.enable`, `agentSandbox.sandboxPod.extraEnv` is
      `scooter.sandboxPod.extraEnv`. The old name read as if the platform were a
      property of the agent's sandbox, when `sandboxPod` is one child among the
      services.
    '';
  # The ingress targets the UI when it is deployed (it proxies the API on the same
  # origin), else the agent-host directly.
  ingressBackend = if cfg.ui.enable then "ui" else "agent-host";

  # The enabled contribs' sandbox-pod parts as a manifest overlay spliced into the
  # Sandbox CR the agent-host creates; empty when nothing contributes.
  contribPodOverlay = lib.optionalAttrs
    (cfg.sandboxPod.extraEnv != [ ] || cfg.sandboxPod.extraVolumes != [ ] || cfg.sandboxPod.extraVolumeMounts != [ ])
    {
      spec.podTemplate.spec = {
        # `sandbox` is the container the overlay's strategic merge keys on.
        containers = [{
          name = "sandbox";
          env = cfg.sandboxPod.extraEnv;
          volumeMounts = cfg.sandboxPod.extraVolumeMounts;
        }];
        volumes = cfg.sandboxPod.extraVolumes;
      };
    };
  # One ConfigMap carries both halves, so it renders when either is non-empty.
  overlayCmNeeded = cfg.deployTools.sandboxManifestOverlay != { } || contribPodOverlay != { };

  # --- Model catalog: fold availableModels (provider -> model id -> opts) into the list
  # the agent-host reads as AGENT_MODELS_JSON, where a model offered by two providers is
  # listed under both.
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
  # The global default for provider-less contexts: the goose group's, else the deprecated
  # agent.model, else any provider's explicit default, else the first model anywhere.
  defaultModelId =
    if providerDefaults ? goose then providerDefaults.goose
    else if cfg.agent.model != null then cfg.agent.model
    # attrValues is alphabetical by provider, but only ever picks a model someone marked `default`.
    else if providerDefaults != { } then lib.head (lib.attrValues providerDefaults)
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
    # A model from the deprecated flat `agent.model` is offered by every provider.
    providers = providersOf id;
    # The providers this model is the default for.
    defaultFor = lib.filter (p: providerDefaults.${p} == id) (lib.attrNames providerDefaults);
  }) modelIds);
  hasModels = modelIds != [ ];

  # Contrib skills read off `config.contribs` and gated on each contrib's `enable`, so
  # an unshipped contrib's skill never documents a route no image serves; deployment
  # `skills` win on a filename collision.
  contribSkills = lib.mapAttrs (_: c: c.skills)
    (lib.filterAttrs (_: c: c.enable && c.skills != { }) config.contribs);

  # The contribs that raise human approvals and how the agent-host reaches their
  # verbs; each contrib's deployment.nix sets its own row inside its own `mkIf`.
  approvalContribsJson =
    if cfg.approvals == { } then null else builtins.toJSON cfg.approvals;
  # Skill DIRECTORIES ship SKILL.md to the agent as `<name>.md`, with a note naming
  # the sandbox copy (modules/sandbox-os/contrib-skills.nix) after the frontmatter,
  # since a skill resolves its scripts/ against "the directory it was loaded from"
  # and the agent-host's copy is not the one the agent's shell can run.
  contribSkillDirs = import ../contrib/skill-dirs.nix { inherit lib; contribs = config.contribs; };
  withSandboxNote = name: text:
    let
      lines = lib.splitString "\n" text;
      note = "> In Scooter this skill's directory is `/etc/scooter/skills/${name}`, in your sandbox. "
        + "Resolve its `scripts/` and `reference/` paths against that directory and run them with your shell.";
      # The index of the frontmatter's closing `---`, or null when there is none.
      close = if lines != [ ] && lib.head lines == "---"
        then lib.findFirst (i: lib.elemAt lines i == "---") null (lib.range 1 (lib.length lines - 1))
        else null;
    in
    if close == null then note + "\n\n" + text
    else lib.concatStringsSep "\n"
      (lib.take (close + 1) lines ++ [ "" note ] ++ lib.drop (close + 1) lines);
  dirSkills = lib.mapAttrs'
    (name: d: lib.nameValuePair "${name}.md" (withSandboxNote name (builtins.readFile "${d.src}/SKILL.md")))
    contribSkillDirs;

  fileSkills = lib.mapAttrs (_: file: builtins.readFile file)
    (lib.concatMapAttrs (_: skills: skills) contribSkills);
  builtins' = lib.optionalAttrs cfg.agent.builtinSkills (
    let clash = lib.intersectLists (lib.attrNames fileSkills) (lib.attrNames dirSkills); in
    if clash != [ ] then throw "contrib skills: ${lib.concatStringsSep ", " clash} is both a skill file and a skill directory."
    else fileSkills // dirSkills);
  allSkills = builtins' // cfg.agent.skills;
in
{
  # ./testing.nix is absent on purpose (test-only overrides are opted into by a test
  # manifest), and the contribs arrive via `contribModules`, each declaring its own
  # `contribs.<name>` options and manifests with contrib/spec.nix as their schema.
  imports = [ kubenix.modules.k8s ./images.nix ./db-spec.nix ./postgres.nix ./db-migrate.nix ./broker.nix ./sandbox-pod.nix ./webhooks.nix ./byoc.nix ./scheduler.nix ./conversation-controller.nix ./warm-store-controller.nix ./legacy-state-migration.nix ./event-backfill.nix ]
    ++ contribModules;

  # Declared only so a definition on the old root reaches `legacyRoot`'s message; no
  # `default`, because a default is injected as a definition and would make
  # `isDefined` true for every render.
  options.agentSandbox = lib.mkOption {
    type = lib.types.raw;
    internal = true;
    visible = false;
    description = "Removed — the platform's option root is `scooter.*` (#710).";
  };

  options.scooter = with lib; {
    namespace = mkOption {
      type = types.str;
      default = "agent-sandbox";
      description = "Namespace for the platform + sandboxes.";
    };

    convTokenSecret = mkOption {
      type = types.str;
      default = "agent-conv-token-secret";
      description = ''
        Name of the Secret holding the HS256 signing key (key `secret`) for CONVERSATION
        TOKENS — the credential that says which conversation an MCP caller is acting for.
        The agent-host signs them and verifies them on its own endpoint; the broker
        verifies them on `/mcp`. ONE key shared by both services, so it is declared here
        rather than under either one.

        Create out-of-band, like `agent.remoteAgent.joinSecret`:
        kubectl create secret generic <name> --from-literal=secret=$(openssl rand -hex 32).

        WIRED UNCONDITIONALLY, and that is deliberate. The reference is a plain
        secretKeyRef with no `optional`, so a missing Secret fails container creation and
        the pod never starts. The alternative — treating an absent key as "no
        authentication" — is a configuration where any in-cluster caller can name any
        conversation and reach its sandbox exec, and whose only symptom is that
        everything works. A pod that refuses to start is the better failure. Why: #700.
      '';
    };

    approvals = mkOption {
      default = { };
      example = literalExpression ''{ aws = { brokerPrefix = "/aws/aws"; pendingPath = "/aws/aws/pending"; }; }'';
      description = ''
        Contribs that raise human approvals -> where their verbs live on the broker.
        Rendered into APPROVAL_CONTRIBS_JSON for the agent-host, which relays a user's
        Approve/Deny there.

        A contrib sets its own row from its DEPLOYMENT module, inside that module's
        `mkIf`, so a deployment that does not run the contrib contributes nothing and
        no separate gate is needed here. Relaying an answer to a broker that never
        mounted the route would turn a security decision into a 404 nobody sees.

        The platform learns only how to REACH the contrib — never what is being
        approved. The prose a human reads is rendered by the contrib and arrives
        already-formed; the UI's half of the declaration (which option to grey) is
        build-time metadata and travels in the contrib manifest instead.
      '';
      type = types.attrsOf (types.submodule {
        options = {
          brokerPrefix = mkOption {
            type = types.str;
            example = "/aws/aws";
            description = ''
              Prefix the approval verbs hang off. The agent-host appends
              `/{requestId}/{optionId}` and `/{requestId}/can-approve`.

              Usually doubled (`/aws/aws`): the core mounts every provider under
              `/{provider.name}`, and a transport's own routes carry their own prefix.
              Spelled out rather than derived, because that second segment is the
              transport's choice, not a platform convention.
            '';
          };
          pendingPath = mkOption {
            type = types.nullOr types.str;
            default = null;
            example = "/aws/aws/pending";
            description = ''
              Where to list still-pending requests for a conversation
              (`?conversation_id=<shortId>`). The agent-host calls it after a revive to
              re-raise approvals a pod rollout dropped — the in-memory answer routing
              dies with the old pod, but the request is still pending in the broker,
              which is the source of truth.

              `null` means no re-raise: a user who had an Approve window open loses it
              silently on a rollout. Set it unless the requests are truly ephemeral.
            '';
          };
        };
      });
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
      default = cfg.images.agent-host.ref.fullUrl;
      defaultText = literalExpression "config.scooter.images.agent-host.ref.fullUrl";
      description = "OCI ref of the agent-host image.";
    };
    sandboxImage = mkOption {
      type = types.str;
      default = cfg.images.agent-sandbox-os.ref.fullUrl;
      defaultText = literalExpression "config.scooter.images.agent-sandbox-os.ref.fullUrl";
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
    sandboxSizes = mkOption {
      type = types.attrsOf (types.submodule {
        options = {
          cpu = mkOption { type = types.str; description = "CPU quantity (requests == limits for Guaranteed QoS), e.g. \"2\" or \"500m\"."; };
          memory = mkOption { type = types.str; description = "Memory quantity (requests == limits for Guaranteed QoS), e.g. \"4Gi\" or \"512Mi\"."; };
          gpu = mkOption {
            type = types.nullOr types.ints.unsigned;
            default = null;
            # k8s requires gpu request == limit, so one count renders on both sides.
            description = "Whole GPUs (nvidia.com/gpu) for this preset; null = none.";
          };
          hint = mkOption {
            type = types.str;
            default = "";
            example = "Parallel builds, large test runs.";
            description = ''
              Deployment guidance for when to pick this size, shown to the AGENT by
              show_sandbox_resources and to the USER under the Sandbox tab's size
              picker (not inside the option labels — an <option> can't wrap, so a
              hint there truncates the cpu/memory numbers). Mirrors
              agent.availableModels.<id>.hint — both pick by workload rather than
              guessing at numbers. Empty = no hint.
            '';
          };
          default = mkOption {
            type = types.bool;
            default = false;
            description = ''
              Mark this preset as the size a new sandbox comes up with. EXACTLY ONE
              preset must set it (see scooter.defaultSandboxSizeName), so the
              default lives beside the numbers it selects rather than in a separate
              option naming a key that has to be kept in sync.
            '';
          };
        };
      });
      # Only two presets ship, because every additional one is a claim about what the
      # cluster's nodes can schedule.
      default = {
        tiny = { cpu = "250m"; memory = "512Mi"; hint = "Chat and light edits."; };
        medium = { cpu = "2"; memory = "4Gi"; hint = "Builds and test suites."; default = true; };
      };
      example = {
        tiny = { cpu = "250m"; memory = "256Mi"; };
        small = { cpu = "1"; memory = "2Gi"; default = true; };
        medium = { cpu = "2"; memory = "4Gi"; };
        large = { cpu = "4"; memory = "16Gi"; };
        xlarge = { cpu = "8"; memory = "32Gi"; };
        gpu-small = { cpu = "4"; memory = "16Gi"; gpu = 1; };
      };
      description = ''
        Named sandbox size presets — a map of preset-name → {cpu, memory}. Each
        preset sets BOTH requests and limits to the same value (Guaranteed QoS), so
        a sandbox at that size is hard-capped and cannot burst into its neighbours'
        resources. The agent can request a preset by name (via set_sandbox_resources),
        and the UI shows a dropdown. Requests == limits for all presets.

        The built-in table ships only `tiny` and `medium`, because every preset is a
        promise that the cluster can schedule that shape — which the platform can't
        make on a deployment's behalf. Bigger sizes and GPU sizes are opt-in: override
        the map to retune, add or remove presets (examples/kubenix-config.nix shows a
        fuller menu). NOTE that with the built-in table there is no size ABOVE the
        default, so a deployment whose agents do heavy builds should add one.

        Exactly one preset sets `default = true` — the size a new sandbox comes up
        with. Set the map to { } to offer no presets at all (the UI then hides the
        picker and the platform default applies).
      '';
    };
    defaultSandboxSizeName = mkOption {
      type = types.nullOr types.str;
      internal = true;
      readOnly = true;
      # Derived from the preset marked `default`, so no second option can drift from the map.
      default =
        let
          flagged = lib.attrNames (lib.filterAttrs (_: p: p.default) cfg.sandboxSizes);
          names = lib.concatStringsSep ", " (lib.attrNames cfg.sandboxSizes);
        in
        # A `throw` rather than an assertion, because kubenix's module system has no
        # `assertions` option.
        if cfg.sandboxSizes == { } then null
        else if lib.length flagged == 1 then lib.head flagged
        else if flagged == [ ] then
          throw ''
            No preset in scooter.sandboxSizes sets `default = true`, so a new
            sandbox has no size to come up with. Mark exactly one (have: ${names}).
          ''
        else
          throw ''
            ${toString (lib.length flagged)} presets in scooter.sandboxSizes set
            `default = true` (${lib.concatStringsSep ", " flagged}); exactly one may.
          '';
      description = ''
        The preset marked `default = true`, resolved from sandboxSizes; null when a
        deployment offers no presets. Read by the agent-host (SANDBOX_DEFAULT_SIZE_NAME + SANDBOX_RESOURCES)
        and by conversation.nix. Not settable —
        declare the default on the preset.
      '';
    };
    # Generic deployment-parameterized tool injection: a deployment fills these with
    # its own .scooter tools and the token audiences and env they need.
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
          # Multi-line values are fine (carried as JSON).
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
          A recursive PATCH deep-merged on top of the generated per-conversation
          Sandbox manifest — so a deployment can change the pod manifest (nodeSelector,
          tolerations, extra env/volumes, annotations, resources, …) WITHOUT patching
          Scooter's code. Rendered to the ConfigMap `sandbox-manifest-overlay` (one key
          `overlay.yaml`) and read by the agent-host at conversation-create time.

          Merge semantics (see services/agent-host/src/session/sandboxOverlay.ts): dicts merge
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
      default = cfg.images.agent-sandbox-ui.ref.fullUrl;
      defaultText = literalExpression "config.scooter.images.agent-sandbox-ui.ref.fullUrl";
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
    # Internal: set by modules/testing.nix, never by a deploy config.
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
          DEPRECATED — use `availableModels.<id>.default = true` instead. When set,
          it's added to the offered set (back-compat for existing deploys) and, unless
          the `goose` provider marks its own default, becomes the global default —
          taking precedence over any OTHER provider's `default` marking. For Bedrock,
          the cross-region inference-profile id.
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
      # Bring-your-own-Claude: users run a container with their own Claude subscription
      # that dials in over a WebSocket, and scooter routes their conversations to it.
      remoteAgent = {
        enable = mkOption {
          type = types.bool;
          default = cfg.byoc.enable;
          defaultText = literalExpression "config.scooter.byoc.enable";
          description = ''
            Bring-your-own-Claude remote agents (the Settings UI + agent-host mint/status routes).
            Defaults to `byoc.enable`: the controller and the host-side routes are two halves of
            ONE feature — enabling the controller without these leaves a Settings page that 404s,
            and enabling these without the controller leaves a one-liner that dials nothing. One
            knob (`scooter.byoc.enable = true`) turns on a working whole.
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
          # Published as "remote-agent" (not the n2c name scooter-remote-agent).
          default = cfg.images.remote-agent.ref.fullUrl;
          defaultText = literalExpression "config.scooter.images.remote-agent.ref.fullUrl";
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
      # Skills the platform ships, each gated on the capability it documents, so the
      # agent never reads instructions for a route that 404s.
      builtinSkills = mkOption {
        type = types.bool;
        default = true;
        description = ''
          Ship the contribs' own skills, each only when the capability it documents
          is built (e.g. scooter-grafana only with contribs.grafana.enable). Set false
          to supply every skill yourself via `skills`. The platform's ungated skills
          are NOT affected — a deployment threads those in through `skills` (the flake
          exposes them as `lib.scooterSkills`).
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
      # The agent-host does no login itself: it trusts an identity header the ingress
      # sets (a missing header means the `anonymous` user), so the ingress must strip
      # any client-supplied copy or identity is spoofable.
      mode = mkOption {
        type = types.enum [ "header" "alb-oidc" ];
        default = "header";
        description = "Identity source: `header` (default; a proxy sets userHeader/emailHeader) or `alb-oidc` (AWS ALB OIDC).";
      };
      # Optional alb-oidc hardening: verify the x-amzn-oidc-data JWT signature before
      # trusting its claims (on failure the id is kept and the claims dropped).
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
      # ALB OIDC only puts the `sub` in a header, so this static sub -> email map
      # seeds the learned identity store.
      subEmailMap = mkOption {
        type = types.attrsOf types.str;
        default = { };
        example = { "cognito-sub-abc" = "alice@example.com"; };
        description = "Optional static map of user id (OIDC sub) -> email, seeding the learned identity store.";
      };
    };

    observability = {
      # Browser telemetry (RUM), separate from `otel` below: the UI pushes OTLP
      # same-origin, because the client-side failures that matter most never reach a
      # pod log.
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

    # A generic networking.k8s.io/v1 Ingress; controller-specific config (auth, the
    # identity header, certs) is passed through `annotations`.
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
      # `scooter.webhooks.ingress` (see webhooks.nix).
    };
  };

  config = {
    # No package: the unfree claude CLI would force allowUnfree.
    scooter.images.remote-agent = { };

    # The agent_host database, which the provisioning Job creates with an owning
    # `agent_host` role whose password lands in `agent-pg-agent-host`.
    scooter.postgres.consumers.agent-host = { db = "agent_host"; user = "agent_host"; };

    # The tables the `agent_host` database holds; owners.toml, the migrator's database
    # list and the grants below are generated from this.
    scooter.db.agent_host = {
      owner = "agent-host";
      tables = {
        conversation_jobs = {
          writers = [ "agent-host" ];
          note = "The background-job registry. Was jobs.json on the emptyDir that every rollout wipes.";
        };
        conversations = {
          writers = [ "agent-host" "conversation-router" "conversation-controller" ];
          note = ''
            Conversation metadata: the sidebar list + rehydration fields. THREE writers, one table:
            agent-host owns the row; conversation-router INSERTs it at create time, writes
            title/starred for IDLE conversations, claims host_pod on first route, and SELECTs
            the table for GET /conversations; conversation-controller writes `phase` and
            (re)assigns host_pod. A writer implies read, so none are also readers.'';
        };
        conversation_events = {
          writers = [ "agent-host" ];
          note = ''
            The conversation event log. Replaces events.jsonl + the NFS mirror. Deliberately NO readers:
            these are full transcripts; the router's grant is table-scoped to `conversations` so it can't
            read them.'';
        };
        conversation_assets = {
          writers = [ "agent-host" ];
          note = "Asset metadata (bytes on dedicated PVC). Replaces in-memory blob URLs.";
        };
        user_skills = {
          writers = [ "agent-host" ];
          note = ''
            Per-user skills authored in the settings page, injected into that user's conversations
            next to the deployment-wide `agent-skills` ConfigMap. agent-host both serves the CRUD
            and reads them at conversation start, so it is the only writer and there are no
            readers: a skill body is user prose about their own repos, not shared config.'';
        };
      };
    };

    # Per-consumer grants derived from the `scooter.db` spec: a table listing the
    # consumer under `readers` becomes SELECT, under `writers` becomes read-write.
    scooter.postgres.readers =
      let
        tablesWhere = consumer: field: db: lib.attrNames (lib.filterAttrs
          (_t: rule: builtins.elem consumer rule.${field})
          (cfg.db.${db}.tables or { }));
        grantFor = consumer: db: {
          inherit db;
          tables = tablesWhere consumer "readers" db;       # SELECT-only
          writeTables = tablesWhere consumer "writers" db;  # read-write
        };
      in
      {
        conversation-router = {
          user = "conversation_router";
          grants = [ (grantFor "conversation-router" "agent_host") ]
            ++ lib.optional cfg.webhooks.enable (grantFor "conversation-router" "webhooks");
        };
        # The controller mirrors conversation phase onto the row, so it gets agent_host only.
        conversation-controller = {
          user = "conversation_controller";
          grants = [ (grantFor "conversation-controller" "agent_host") ];
        };
      };

    # mkMerge, not //: the optional UI and ingress blocks also define `deployments` /
    # `services`, and a shallow update would drop agent-host.
    kubernetes.resources = lib.mkMerge [
    {
      # Both guards are forced from the namespace name because every render produces
      # it, and both return it unchanged unless the mistake is present.
      namespaces.${shipGate (legacyRoot cfg.namespace)} = {
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

      # The agent-host provisions per-conversation Sandboxes/SAs/PVCs and execs into
      # sandbox pods, so it alone gets this namespaced RBAC.
      roles.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        rules =
          [
            {
              # The WebSocket exec stream opens with an HTTP GET upgrade, which RBAC
              # checks as `get pods/exec`, so `create` alone is not enough.
              apiGroups = [ "" ];
              resources = [ "pods/exec" ];
              verbs = [ "get" "create" ];
            }
            {
              apiGroups = [ "agents.x-k8s.io" ];
              resources = [ "sandboxes" ];
              verbs = [ "get" "list" "watch" "create" "update" "patch" "delete" ];
            }
            {
              apiGroups = [ "" ];
              # configmaps: destroy() reaps the legacy per-conversation module ConfigMap
              # older clusters still carry.
              resources = [ "serviceaccounts" "persistentvolumeclaims" "pods" "configmaps" ];
              verbs = [ "get" "list" "watch" "create" "update" "patch" "delete" ];
            }
            {
              # The agent-host watches Conversations for ownership fencing, creates one
              # per new conversation, and merge-patches spec.sandboxRef onto the CR the
              # router created without one.
              apiGroups = [ "scooter.chadac.dev" ];
              resources = [ "conversations" ];
              # delete: ending a conversation must remove its CR, or hydrate() re-adopts it.
              verbs = [ "get" "list" "watch" "create" "patch" "delete" ];
            }
            {
              # The agent-host publishes liveness to status.phase via
              # conversationRegistry.setPhase; status is its own subresource for RBAC,
              # hence the separate rule.
              apiGroups = [ "scooter.chadac.dev" ];
              resources = [ "conversations/status" ];
              verbs = [ "get" "patch" "update" ];
            }
          ];
      };

      # TokenReview is cluster-scoped, so a ClusterRole; the agent-host verifies the
      # webhooks SA token on /agui to honor a conversation `owner`.
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

      # A Deployment with maxSurge=1/maxUnavailable=0, so a new pod is Ready before any
      # old pod drains; routing is by pod IP (status.hostIP), and the per-pod `state`
      # volume is an emptyDir hot cache of the durable history mirror.
      deployments.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        # When the controller autoscales it is the single writer of spec.replicas, so the
        # manifest omits it (lib.optionalAttrs rather than mkIf, since this is a resource
        # attrset, not a module option).
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
              # fsGroup 0 so the root agent-host process can write its scratch/state dirs.
              securityContext = {
                fsGroup = 0;
                fsGroupChangePolicy = "OnRootMismatch";
              };
              containers.agent-host = {
                name = "agent-host";
                image = cfg.agentHostImage;
                imagePullPolicy = cfg.pullPolicy;
                # Memory-limited to protect the node with no cpu limit; memory scales with
                # active conversations (each holds a hydrated event log and an agent CLI
                # heap), so the limit covers the handful a replica hosts.
                resources = lib.mkDefault {
                  requests = { cpu = "250m"; memory = "1Gi"; };
                  limits = { memory = "2Gi"; };
                };
                ports = [{ containerPort = 8080; name = "agui"; }];
                env = [
                  { name = "PORT"; value = "8080"; }
                  { name = "NAMESPACE"; value = cfg.namespace; }
                  # This pod's own name (downward API): its identity for the Conversation
                  # CRD hostPod and generation fencing.
                  { name = "POD_NAME"; valueFrom.fieldRef.fieldPath = "metadata.name"; }
                  { name = "SANDBOX_IMAGE"; value = cfg.sandboxImage; }
                  # imagePullPolicy for the sandbox pods mirrors the platform pullPolicy,
                  # since the provisioner's default of Always fails on a local cluster
                  # without a registry.
                  { name = "SANDBOX_PULL_POLICY"; value = cfg.pullPolicy; }
                  # Comma-separated SAs allowed to set a conversation `owner` on /agui
                  # (verified via TokenReview): webhooks always, the scheduler when enabled.
                  { name = "WEBHOOKS_SERVICE_ACCOUNT";
                    value = lib.concatStringsSep "," (
                      [ "system:serviceaccount:${cfg.namespace}:agent-webhooks" ]
                      ++ lib.optional cfg.scheduler.enable "system:serviceaccount:${cfg.namespace}:agent-scheduler"
                    ); }
                  # Subagent creation goes through the router.
                  { name = "CONVERSATION_ROUTER_URL"; value = "http://agent-host.${cfg.namespace}.svc.cluster.local:8080"; }
                  { name = "CONVERSATION_ROUTER_TOKEN_PATH"; value = "/var/run/secrets/conversation-router/token"; }
                  # emptyDir hot cache of the AG-UI event log; the durable record is the
                  # history mirror.
                  { name = "LOCAL_STATE_PATH"; value = "/var/lib/agent-host/conversations"; }
                  # Ephemeral scratch (emptyDir) for goose's per-conversation cwd and
                  # $HOME; the agent's real work execs into the sandbox.
                  { name = "SCRATCH_PATH"; value = "/var/lib/agent-scratch"; }
                  { name = "HOME"; value = "/var/lib/agent-scratch/home"; }
                  { name = "IDLE_SUSPEND_MS"; value = toString cfg.idleSuspendMs; }
                ]
                ++ lib.optional cfg.conversationController.assets.enable
                  { name = "ASSETS_PATH"; value = "/var/lib/agent-assets"; }
                ++ lib.optional cfg.byoc.traceTunnel
                  # Per-frame tracing of the BYOC MCP tunnel, off by default because it
                  # would drown a normal log.
                  { name = "TUNNEL_TRACE"; value = "1"; }
                ++ [
                ]
                ++ lib.optional (cfg.sandboxRuntimeClass != null)
                  # A cgroup-delegating RuntimeClass (e.g. crun) lets the sandbox's systemd
                  # run non-privileged in a private cgroup namespace; unset means the
                  # cluster default.
                  { name = "SANDBOX_RUNTIME_CLASS"; value = cfg.sandboxRuntimeClass; }
                ++ lib.optional (cfg.retentionMaxAgeMs > 0)
                  # Auto-delete unstarred conversations inactive past the window (absent
                  # unless a deployment opts in).
                  { name = "RETENTION_MAX_AGE_MS"; value = toString cfg.retentionMaxAgeMs; }
                ++ [
                  # Agent identity and skills, written into the per-conversation
                  # .goosehints; SKILLS_DIR is the ConfigMap mount.
                  { name = "AGENT_NAME"; value = cfg.agent.name; }
                  { name = "SKILLS_DIR"; value = "/etc/agent-sandbox/skills"; }
                ] ++ lib.optional (cfg.ingress.host != "")
                  # Public chat UI base URL, so each sandbox gets a CONVERSATION_URL; keyed
                  # on the host rather than ingress.enable because the host is public
                  # even when an external proxy fronts it.
                  { name = "PUBLIC_URL"; value = "https://${cfg.ingress.host}"; }
                ++ lib.optional (cfg.auth.mode != "header")
                  # Identity provider: header (default) or alb-oidc.
                  { name = "AUTH_MODE"; value = cfg.auth.mode; }
                ++ lib.optional cfg.auth.albVerify
                  # Verifying the ALB JWT needs a region (the public-key host is
                  # region-specific), so assert rather than guess.
                  (assert lib.assertMsg (cfg.auth.albRegion != null)
                    "scooter.auth.albVerify = true requires scooter.auth.albRegion to be set (the ALB public-key endpoint is region-specific).";
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
                  # Scheduled-task MCP tools, proxied to the scheduler service and scoped
                  # to the conversation owner.
                  { name = "SCHEDULER_URL"; value = "http://agent-scheduler.${cfg.namespace}.svc.cluster.local:8080"; }
                ] ++ lib.optional (cfg.scheduler.relayKey != "")
                    { name = "SCHEDULER_RELAY_KEY"; value = cfg.scheduler.relayKey; })
                ++ lib.optional (!cfg.fakeAgent)
                  # Real `goose acp`; the provider selects the model backend.
                  { name = "GOOSE_PROVIDER"; value = cfg.agent.provider; }
                ++ lib.optionals (!cfg.fakeAgent && cfg.agent.provider != "claude-code") [
                  # Bedrock (or another AWS-backed provider): the agent inherits the pod's
                  # IRSA identity via the AWS SDK web-identity chain.
                  { name = "AWS_REGION"; value = cfg.agent.region; }
                  { name = "AWS_DEFAULT_REGION"; value = cfg.agent.region; }
                ] ++ lib.optionals (!cfg.fakeAgent && cfg.agent.provider == "claude-code") [
                  # claude-code provider: the agent-host drives the agent via the Claude
                  # Agent SDK, whose shell/file tools run in the sandbox through an
                  # in-process MCP server, with the subscription OAuth token from a Secret.
                  {
                    name = "CLAUDE_CODE_OAUTH_TOKEN";
                    valueFrom.secretKeyRef = { name = cfg.agent.claudeCode.tokenSecret; key = "token"; };
                  }
                  # The SDK's bundled musl `claude` fails on the glibc image, so point it
                  # at the glibc `claude` on PATH.
                  { name = "CLAUDE_CODE_COMMAND"; value = "claude"; }
                  # The SDK runs `claude --dangerously-skip-permissions`, which is refused
                  # under root unless IS_SANDBOX marks a sandboxed context.
                  { name = "IS_SANDBOX"; value = "1"; }
                ] ++ lib.optional (defaultModelId != null)
                  # The default model, derived from availableModels.<id>.default (or the
                  # deprecated agent.model).
                  { name = "GOOSE_MODEL"; value = defaultModelId; }
                ++ lib.optional hasModels
                  # The catalog is DATA, not an agent capability: a fake agent still has
                  # models to list, group by provider and switch between, and gating it on
                  # fakeAgent left the cluster tier unable to test any of that.
                  { name = "AGENT_MODELS_JSON"; value = modelsJson; }
                ++ lib.optional cfg.fakeAgent
                  # Run the bundled dummy ACP agent (no model, no cluster) for the cluster e2e.
                  { name = "GOOSE_BIN"; value = "fake"; }
                ++ lib.optional (cfg.sandboxResources != null || cfg.defaultSandboxSizeName != null)
                  # The default size a new sandbox comes up at as a rendered k8s resources
                  # block; the internal sandboxResources override wins because the test
                  # size is Burstable, which a preset cannot express.
                  { name = "SANDBOX_RESOURCES";
                    value = if cfg.sandboxResources != null then builtins.toJSON cfg.sandboxResources
                    else
                    let
                      preset = cfg.sandboxSizes.${cfg.defaultSandboxSizeName};
                      # A GPU renders under its extended-resource name on both sides, since
                      # k8s rejects a GPU request that differs from its limit.
                      side = { cpu = preset.cpu; memory = preset.memory; }
                        // lib.optionalAttrs (preset.gpu != null) { "nvidia.com/gpu" = toString preset.gpu; };
                    in builtins.toJSON { requests = side; limits = side; };
                  }
                ++ [
                  # The agent-host mints a conversation token per conversation as the MCP
                  # endpoint's bearer credential and verifies it there, as does the broker
                  # on /mcp; no `optional`, so a missing Secret fails container creation
                  # rather than degrading to an open endpoint.
                  {
                    name = "CONV_TOKEN_SECRET";
                    valueFrom.secretKeyRef = { name = cfg.convTokenSecret; key = "secret"; };
                  }
                ]
                ++ lib.optionals cfg.agent.remoteAgent.enable [
                  # Bring-your-own-Claude: the HS256 signing key for owner-bound join tokens.
                  {
                    name = "REMOTE_AGENT_JOIN_SECRET";
                    valueFrom.secretKeyRef = { name = cfg.agent.remoteAgent.joinSecret; key = "secret"; };
                  }
                  # The ghcr image the Settings one-liner references.
                  { name = "REMOTE_AGENT_IMAGE"; value = cfg.agent.remoteAgent.image; }
                ]
                ++ lib.optional (cfg.agent.remoteAgent.enable && cfg.agent.remoteAgent.bridgeUrl != "")
                  # The BYOC controller's public base URL, which the user's container dials
                  # (/byoc/ws/<session-id> appended per owner).
                  { name = "BYOC_PUBLIC_URL"; value = cfg.agent.remoteAgent.bridgeUrl; }
                ++ lib.optional cfg.byoc.enable
                  # The controller's in-cluster base, where the agent-host mints sessions,
                  # resolves ownership, and sends every ACP frame.
                  { name = "BYOC_CONTROLLER_URL"; value = "http://byoc-controller.${cfg.namespace}.svc.cluster.local:8080"; }
                ++ lib.optional (approvalContribsJson != null)
                  # The contribs that raise human approvals, name -> where its verbs live
                  # on the broker, so the agent-host can relay a user's Approve/Deny.
                  { name = "APPROVAL_CONTRIBS_JSON"; value = approvalContribsJson; }
                ++ lib.optionals cfg.broker.enable [
                  # BROKER_URL and the projected broker token for the approve/deny relay
                  # and the shares/links queries the agent-host makes on a conversation's
                  # behalf.
                  { name = "BROKER_URL"; value = "http://agent-broker.${cfg.namespace}.svc.cluster.local:8080"; }
                  { name = "BROKER_TOKEN_PATH"; value = "/var/run/secrets/broker/token"; }
                ] ++ lib.optionals overlayCmNeeded [
                  # The manifest-overlay ConfigMap (patches deep-merged onto the generated
                  # Sandbox), read at create time so an edit lands on the next conversation.
                  { name = "SANDBOX_MANIFEST_OVERLAY_CONFIGMAP"; value = "sandbox-manifest-overlay"; }
                ] ++ [
                  # The named size catalog and which preset is the default, behind the UI
                  # dropdown and the agent's size discovery.
                  { name = "SANDBOX_SIZES_JSON";
                    value = builtins.toJSON (lib.mapAttrs (_name: preset:
                      { cpu = preset.cpu; memory = preset.memory; }
                      // lib.optionalAttrs (preset.gpu != null) { gpu = preset.gpu; }
                      # Omit an empty hint, since the agent and the dropdown branch on presence.
                      // lib.optionalAttrs (preset.hint != "") { hint = preset.hint; }
                    ) cfg.sandboxSizes);
                  }
                  # "" (not null) when no presets are configured, since an env value must be
                  # a string and the agent-host reads empty as no default.
                  { name = "SANDBOX_DEFAULT_SIZE_NAME";
                    value = if cfg.defaultSandboxSizeName == null then "" else cfg.defaultSandboxSizeName;
                  }
                ] ++ lib.optionals (cfg.deployTools.scooterConfigMap != null) [
                  # Generic deployment tool injection: the agent-host mounts the .scooter
                  # ConfigMap, projects the token audiences, and sets the deployment env
                  # on each sandbox.
                  { name = "SCOOTER_CONFIGMAP"; value = cfg.deployTools.scooterConfigMap; }
                ] ++ lib.optional (cfg.deployTools.tokenAudiences != [ ])
                  { name = "SCOOTER_TOKEN_AUDIENCES"; value = lib.concatStringsSep "," cfg.deployTools.tokenAudiences; }
                ++ lib.optional (cfg.deployTools.env != { })
                  # JSON rather than `k=v;k=v`, so values with newlines, `;` or `=`
                  # round-trip losslessly.
                  { name = "SCOOTER_ENV"; value = builtins.toJSON cfg.deployTools.env; }
                ++ lib.optional (cfg.deployTools.configFiles != { })
                  # Mounted by the agent-host as a flat dir at /etc/agent-sandbox/config in
                  # each sandbox, file-based so multi-line config survives the CRD controller.
                  { name = "SCOOTER_CONFIG_FILES_CONFIGMAP"; value = "deploy-config-files"; }
                ++ lib.optionals cfg.observability.otel.enable ([
                  # OTel metrics on; the OTLP endpoint/headers come from
                  # observability.otel.env and pricing from the mounted ConfigMap.
                  { name = "OTEL_METRICS_ENABLED"; value = "1"; }
                  { name = "OTEL_SERVICE_NAME"; value = "agent-host"; }
                ] ++ lib.optional (cfg.observability.otel.environment != null)
                    { name = "OTEL_DEPLOYMENT_ENVIRONMENT"; value = cfg.observability.otel.environment; }
                  ++ lib.optional (cfg.observability.otel.pricing != { })
                    { name = "AGENT_PRICING_FILE"; value = "/etc/agent-sandbox/pricing/pricing.json"; }
                  ++ lib.mapAttrsToList (k: v: { name = k; value = v; }) cfg.observability.otel.env)
                ++ lib.optionals cfg.webhooks.enable ([
                  # Read access to the webhooks conversation_map and identity store, using
                  # the webhooks role's own secret.
                  { name = "WEBHOOKS_DB_HOST"; value = cfg.postgres.host; }
                  { name = "WEBHOOKS_DB_PORT"; value = toString cfg.postgres.port; }
                  { name = "WEBHOOKS_DB_NAME"; value = "webhooks"; }
                  { name = "WEBHOOKS_DB_USER"; value = "webhooks"; }
                  { name = "WEBHOOKS_DB_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-webhooks"; key = "password"; }; }
                ] ++ lib.optional (cfg.postgres.sslmode != null) { name = "WEBHOOKS_DB_SSLMODE"; value = cfg.postgres.sslmode; })
                # The BYOC database, where agent-host writes byoc.remote_agents alongside
                # byoc-controller; gated on BYOC, not on webhooks.
                ++ lib.optionals cfg.byoc.enable ([
                  { name = "BYOC_DB_HOST"; value = cfg.postgres.host; }
                  { name = "BYOC_DB_PORT"; value = toString cfg.postgres.port; }
                  { name = "BYOC_DB_NAME"; value = "byoc"; }
                  { name = "BYOC_DB_USER"; value = "byoc"; }
                  { name = "BYOC_DB_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-byoc"; key = "password"; }; }
                ] ++ lib.optional (cfg.postgres.sslmode != null) { name = "BYOC_DB_SSLMODE"; value = cfg.postgres.sslmode; })
                # The agent_host database (the tables agent-host owns), wired whenever
                # Postgres is configured rather than behind another service's flag.
                ++ [
                  { name = "AGENT_HOST_DB_HOST"; value = cfg.postgres.host; }
                  { name = "AGENT_HOST_DB_PORT"; value = toString cfg.postgres.port; }
                  { name = "AGENT_HOST_DB_NAME"; value = "agent_host"; }
                  { name = "AGENT_HOST_DB_USER"; value = "agent_host"; }
                  { name = "AGENT_HOST_DB_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-agent-host"; key = "password"; }; }
                ] ++ lib.optional (cfg.postgres.sslmode != null) { name = "AGENT_HOST_DB_SSLMODE"; value = cfg.postgres.sslmode; };
                volumeMounts = [
                  # Per-pod hot history cache.
                  { name = "state"; mountPath = "/var/lib/agent-host"; }
                  # Ephemeral agent scratch (emptyDir): goose cwd + $HOME.
                  { name = "scratch"; mountPath = "/var/lib/agent-scratch"; }
                  # The image's /tmp is read-only and goose needs a writable one.
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
                ++ lib.optional cfg.broker.enable
                  # The agent-host's own broker token for the approve/deny relay and the
                  # shares/links queries it makes on a conversation's behalf.
                  { name = "broker-token"; mountPath = "/var/run/secrets/broker"; readOnly = true; }
                ++ [
                  { name = "conversation-router-token"; mountPath = "/var/run/secrets/conversation-router"; readOnly = true; }
                ];
                readinessProbe.httpGet = { path = "/healthz"; port = "agui"; };
                # preStop sleeps so endpoint removal propagates before SIGTERM, and the
                # grace period stays above preStop + SHUTDOWN_TIMEOUT_MS so the drain can
                # finish.
                lifecycle.preStop.exec.command = [ "sleep" "5" ];
              };
              terminationGracePeriodSeconds = 20;
              # `state` is an emptyDir hot cache of the durable history mirror, which is what
              # lets the Deployment surge without a Multi-Attach deadlock.
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
              ++ lib.optional cfg.broker.enable
                { name = "broker-token"; projected.sources = [{ serviceAccountToken = { audience = "agent-broker"; path = "token"; }; }]; }
              ++ [
                # Audience `agent-host`, the Service the router fronts.
                { name = "conversation-router-token";
                  projected.sources = [{ serviceAccountToken = { audience = "agent-host"; path = "token"; }; }]; }
              ];
            };
          };
        };
      };


      # Agent skills (filename -> markdown) injected per conversation as .goosehints;
      # edit the ConfigMap to change a skill without an image rebuild.
      configMaps = lib.optionalAttrs (allSkills != { }) {
        agent-skills = {
          metadata = { name = "agent-skills"; namespace = cfg.namespace; };
          data = allSkills;
        };
      } // lib.optionalAttrs (cfg.deployTools.configFiles != { }) {
        # Deployment config files mounted as a flat dir at /etc/agent-sandbox/config in
        # each sandbox (SCOOTER_CONFIG_FILES_CONFIGMAP).
        deploy-config-files = {
          metadata = { name = "deploy-config-files"; namespace = cfg.namespace; };
          data = cfg.deployTools.configFiles;
        };
      } // lib.optionalAttrs overlayCmNeeded {
        # Manifest overlays deep-merged onto the generated Sandbox, read by name at
        # create time so an edit takes effect on the next conversation.
        sandbox-manifest-overlay = {
          metadata = { name = "sandbox-manifest-overlay"; namespace = cfg.namespace; };
          # Each key holds a whole patch as YAML; the host merges contrib under consumer,
          # so a deployment can override a contrib's env or volume by name.
          data = lib.optionalAttrs (cfg.deployTools.sandboxManifestOverlay != { }) {
            "overlay.yaml" = builtins.toJSON cfg.deployTools.sandboxManifestOverlay;
          } // lib.optionalAttrs (contribPodOverlay != { }) {
            "contrib.yaml" = builtins.toJSON contribPodOverlay;
          };
        };
      } // lib.optionalAttrs (cfg.observability.otel.enable && cfg.observability.otel.pricing != { }) {
        # Per-model price table in the shape pricing.ts parses; null cached rates are dropped.
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

      # The `agent-host` Service is the front door every caller uses; it selects the
      # router, which reverse-proxies each request to the pod owning the conversation.
      services.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        spec = {
          selector.app = "conversation-router";  # the front door always fronts the router
          ports = [{ port = 8080; targetPort = "agui"; name = "agui"; }];
        };
      };
      # ClusterIP Service selecting the agent-host pods directly: the router's fallback
      # target for unassigned or stale-IP requests.
      services.agent-host-pods = {
        metadata = { name = "agent-host-pods"; namespace = cfg.namespace; };
        spec = {
          selector.app = "agent-host";
          ports = [{ port = 8080; targetPort = "agui"; name = "agui"; }];
        };
      };
    }
    # The PVC is provisioned when the mirror is in use, or kept alive so the Postgres
    # migration can read history out of it.
    (lib.mkIf (cfg.conversationController.historyMirror.enable
               || cfg.conversationController.historyMirror.retainForMigration) (
      let hm = cfg.conversationController.historyMirror; in {
        # Shared ReadWriteMany history-mirror PVC every agent-host pod appends to, from
        # which a reassigned conversation's new host reads its history back.
        persistentVolumeClaims.agent-host-history = {
          metadata = { name = "agent-host-history"; namespace = cfg.namespace; };
          spec = {
            accessModes = [ hm.accessMode ];
            resources.requests.storage = hm.size;
          }
          # The hostPath escape hatch binds to the explicit PV below by class; otherwise
          # the given/default class.
          // (if hm.hostPath != null
              then { storageClassName = "agent-host-history-hostpath"; }
              else lib.optionalAttrs (hm.storageClassName != null) { storageClassName = hm.storageClassName; });
        };
      }
      # Single-node hostPath PV so a ReadWriteMany PVC binds where there is no RWX
      # provisioner.
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
    (lib.mkIf cfg.conversationController.assets.enable (
      let as = cfg.conversationController.assets; in {
      # Dedicated bytes-only assets PVC (metadata lives in Postgres), ReadWriteMany so
      # every replica writes to it.
      persistentVolumeClaims.agent-host-assets = {
        metadata = { name = "agent-host-assets"; namespace = cfg.namespace; };
        spec = {
          accessModes = [ as.accessMode ];
          resources.requests.storage = as.size;
        }
        # The hostPath escape hatch binds to the explicit PV below by class; otherwise
        # the given/default class.
        // (if as.hostPath != null
            then { storageClassName = "agent-host-assets-hostpath"; }
            else lib.optionalAttrs (as.storageClassName != null) { storageClassName = as.storageClassName; });
      };
    }
    # Single-node hostPath PV so a ReadWriteMany assets PVC binds where there is no RWX
    # provisioner.
    // lib.optionalAttrs (cfg.conversationController.assets.hostPath != null) {
      persistentVolumes.agent-host-assets = {
        metadata.name = "agent-host-assets";
        spec = {
          capacity.storage = cfg.conversationController.assets.size;
          accessModes = [ cfg.conversationController.assets.accessMode ];
          storageClassName = "agent-host-assets-hostpath";
          persistentVolumeReclaimPolicy = "Retain";
          hostPath = { path = cfg.conversationController.assets.hostPath; type = "DirectoryOrCreate"; };
        };
      };
    }
    ))
    (lib.mkIf cfg.ui.enable {
      # Conversation UI: nginx serving the assistant-ui build and proxying the
      # agent-host API on the same origin.
      deployments.ui = {
        metadata = { name = "ui"; namespace = cfg.namespace; };
        spec = {
          # Stateless, so several replicas keep the UI up through a node drain.
          replicas = cfg.statelessReplicas;
          selector.matchLabels.app = "ui";
          template = {
            metadata.labels.app = "ui";
            spec.containers.ui = {
              name = "ui";
              image = cfg.uiImage;
              imagePullPolicy = cfg.pullPolicy;
              # A static file server, so a small footprint.
              resources = lib.mkDefault {
                requests = { cpu = "50m"; memory = "64Mi"; };
                limits = { memory = "256Mi"; };
              };
              ports = [{ containerPort = 8080; name = "http"; }];
              env = [{
                name = "AGENT_HOST_URL";
                value = "http://agent-host.${cfg.namespace}.svc.cluster.local:8080";
              } {
                # nginx forwards /s/ (static shares) here so the broker stays
                # cluster-internal; harmless when shares is off.
                name = "BROKER_URL";
                value = "http://agent-broker.${cfg.namespace}.svc.cluster.local:8080";
              }] ++ lib.optionals cfg.observability.browserTelemetry.enable [
                # Where nginx forwards /telemetry/, asserted rather than defaulted because
                # a wrong collector URL fails silently.
                (assert lib.assertMsg (cfg.observability.browserTelemetry.collectorUrl != null)
                  "scooter.observability.browserTelemetry.enable = true requires observability.browserTelemetry.collectorUrl to be set (e.g. http://alloy-singleton.monitoring.svc.cluster.local:4318 for the Grafana k8s-monitoring chart). There is no safe default: a wrong collector URL discards telemetry silently.";
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
      # The chat/API Ingress: all controller-specific config, including auth and the
      # trusted identity header, comes from `annotations`, and the module gates
      # nothing itself.
      ingresses.agent-host = {
        metadata = {
          name = "agent-host";
          namespace = cfg.namespace;
          annotations = cfg.ingress.annotations;
        };
        spec = {
          ingressClassName = lib.mkIf (cfg.ingress.className != "") cfg.ingress.className;
          rules = [(
            # Omit `host` when unset, since a host-less rule is a valid catch-all while
            # `host: ""` is rejected by some controllers.
            lib.optionalAttrs (cfg.ingress.host != "") { host = cfg.ingress.host; }
            // {
              http.paths = [{
                path = "/";
                pathType = "Prefix";
                backend.service = { name = ingressBackend; port.number = 8080; };
              }];
            }
          )];
          # Only emit a tls entry when there is a host to name.
          tls = lib.optionals (cfg.ingress.tls && cfg.ingress.host != "") [
            ({ hosts = [ cfg.ingress.host ]; }
              // lib.optionalAttrs (cfg.ingress.tlsSecretName != "") {
                secretName = cfg.ingress.tlsSecretName;
              })
          ];
        };
      };
    })
    # The webhooks receiver gets its own Ingress in webhooks.nix, with no auth since
    # the handlers verify provider signatures themselves.
    ];
  };
}
