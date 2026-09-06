{
  description = "Nix-powered agent sandbox platform layered over the Kubernetes agent-sandbox controller";

  inputs = {
    # The single nixpkgs the platform AND the sandbox build from. The sandbox's
    # lazy-tool stubs + the runtime re-converge resolve against `path:${nixpkgs}`,
    # the SAME source the image baked with — so a re-converge is a near-noop diff
    # against the baked store (no toolchain re-fetch). (There used to be a separate
    # `nixpkgs-pinned` input for the stubs; that drift was the cause of the slow
    # first re-converge, so it's unified onto this one.)
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    nix2container = {
      url = "github:nlewo/nix2container";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    kubenix = {
      url = "github:hall/kubenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # Lazy package shims (compiled dispatcher): a tool is on PATH as a shim that
    # realises its .drv on first use, then execs the real binary. Only the .drv is
    # baked into the image (tiny) — the built package materializes into the writable
    # store on first call, keeping rarely-used heavies (awscli2) out of the base
    # image closure. Replaces the homegrown modules/sandbox-os/lazy-tools.nix.
    nix-stubs = {
      url = "github:chadac/nix-stubs";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # uv patched to work under Nix: wheels/interpreters are fixed up so Nix-supplied
    # native libs (BLAS/LAPACK for numpy/scipy, etc.) resolve without manual
    # LD_LIBRARY_PATH. Backs the in-pod marimo so `uv add matplotlib` / --sandbox
    # science deps actually import. The `/bin` variant is a prebuilt binary (no compile).
    uv-nix = {
      url = "github:chadac/uv-nix/bin";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs@{ self, nixpkgs, flake-parts, nix2container, kubenix, nix-stubs, uv-nix }:
    let
      # The built-in agent skills: every ./skills/*.md read into the
      # `filename -> content` attrset the platform module's `agent.skills` option
      # expects (rendered to the agent-skills ConfigMap, mounted at SKILLS_DIR,
      # assembled into each conversation's .goosehints). The module default is `{}`
      # (a kubenix module can't read a flake-relative dir), so a deploy that wants
      # the shipped skills threads THESE in — the default `platform` render below
      # does, and it's exposed as `lib.scooterSkills` for external deployers. System-
      # independent (pure file reads), so defined once here on nixpkgs.lib.
      scooterSkills =
        let dir = ./skills; l = nixpkgs.lib;
        in l.mapAttrs' (name: _: {
          inherit name; # keep the .md filename as the ConfigMap key
          value = builtins.readFile (dir + "/${name}");
        }) (l.filterAttrs (n: t: t == "regular" && l.hasSuffix ".md" n)
          (builtins.readDir dir));

      # --- Content-tagged ghcr image refs (SYSTEM-INDEPENDENT) -------------------
      # Hoisted to the top-level let (like scooterSkills) so BOTH the perSystem
      # renders AND the system-independent kubenixModules can share one definition.
      # The tag is the image's 12-char store hash; pinned to x86_64-linux (see the
      # long note by ghcrImages) so the ref is a fixed string on any eval system and
      # matches exactly what the x86_64 publish-images workflow pushes.
      #
      # unsafeDiscardStringContext is REQUIRED: interpolating `img.outPath` attaches
      # the image derivation as string CONTEXT, and that context survives baseNameOf
      # + substring — so without discarding it the tag string carries every image as
      # a build dependency, and any derivation embedding these refs would REALISE all
      # the images just to read their hashes. We only want the hash as TEXT.
      ghcrContentTag = img:
        builtins.unsafeDiscardStringContext
          (builtins.substring 0 12 (builtins.baseNameOf img.outPath));
      ghcrPrefix = "ghcr.io/chadac/scooter/";
      ghcrImageRef = name: img: "${ghcrPrefix}${name}:${ghcrContentTag img}";
      # CONTENT TAGS ARE PINNED TO x86_64-linux — deliberately, and it's what makes
      # ghcrImages system-independent (a fixed string regardless of the eval system),
      # so the bare kubenix module defaults (modules/platform.nix, via the exported
      # kubenixModules.default) can embed them. It's also what's CORRECT: the
      # publish-images workflow runs on ubuntu-latest (x86_64) and pushes `.#<attr>` =
      # the x86_64 image under its x86_64 content tag. Per-system image derivations
      # hash differently per arch, so computing the tag from the LOCAL (eval-system)
      # image would, on aarch64, yield a tag that was NEVER pushed. Reading
      # self.packages.x86_64-linux.<attr> pins to the arch we actually publish. The tag
      # is a registry ref (pure TEXT), NOT an arch selector; the pushed image can be
      # multi-arch under that same tag. `nix build .#<attr>` on aarch64 still builds an
      # aarch64 image locally (unaffected); only the ghcr REF text is x86_64-pinned.
      pubImages = self.packages.x86_64-linux;
      # The content-tagged ghcr image refs (the kubenix DEFAULTS). A deploy that ships
      # to another registry overrides these via agentSandbox.*Image / registryPrefix
      # (e.g. the odin localhost:5000 deploy). The FREE images are a PURE set (no flags
      # needed). The claude variant bakes the UNFREE claude-code CLI, so its .outPath
      # forces an allowUnfree check — split out, resolved only under --impure +
      # NIXPKGS_ALLOW_UNFREE. Image NAMES match the canonical agent-* convention.
      # ── k3d-registry refs for the E2E FULL cluster. The registry is created by
      # k3d as `k3d-scooter-reg.localhost` (see ci.yml / cluster-up.sh): a
      # `.localhost` name resolves to 127.0.0.1 on the HOST (so skopeo pushes to it
      # straight from /nix/store — no docker-daemon load, no `k3d image import`
      # tarball; unchanged layers are skipped by digest) and to the registry
      # container via docker DNS INSIDE the cluster — one ref works on both sides.
      # Content tags (not :latest) make pullPolicy IfNotPresent correct: a rebuilt
      # image gets a new tag -> pull; an unchanged one is already present -> skip.
      k3dRegistry = "k3d-scooter-reg.localhost:5800";
      k3dImageRef = name: img: "${k3dRegistry}/${name}:${ghcrContentTag img}";
      k3dImages = {
        agentHost = k3dImageRef "agent-host" pubImages.agent-host-image;
        ui = k3dImageRef "agent-sandbox-ui" pubImages.ui-image;
        broker = k3dImageRef "agent-broker" pubImages.broker-image;
        webhooks = k3dImageRef "agent-webhooks" pubImages.webhooks-image;
        sandboxOs = k3dImageRef "agent-sandbox-os" pubImages.sandbox-os-image;
        conversationController = k3dImageRef "conversation-controller" pubImages.conversation-controller-image;
        conversationRouter = k3dImageRef "conversation-router" pubImages.conversation-router-image;
      };
      # attr -> ref, for the push script: `nix build .#k3d-image-refs` + jq. Keyed by
      # the FLAKE IMAGE ATTR whose `.copyTo` pushes it.
      k3dImagePushMap = {
        agent-host-image = k3dImages.agentHost;
        ui-image = k3dImages.ui;
        broker-image = k3dImages.broker;
        webhooks-image = k3dImages.webhooks;
        sandbox-os-image = k3dImages.sandboxOs;
        conversation-controller-image = k3dImages.conversationController;
        conversation-router-image = k3dImages.conversationRouter;
      };

      ghcrImages = {
        agentHost = ghcrImageRef "agent-host" pubImages.agent-host-image;
        ui = ghcrImageRef "agent-sandbox-ui" pubImages.ui-image;
        broker = ghcrImageRef "agent-broker" pubImages.broker-image;
        scheduler = ghcrImageRef "agent-scheduler" pubImages.scheduler-image;
        webhooks = ghcrImageRef "agent-webhooks" pubImages.webhooks-image;
        sandboxOs = ghcrImageRef "agent-sandbox-os" pubImages.sandbox-os-image;
        # The CONTROLLERS. Absent here, the production render left them on their module
        # defaults — i.e. `:latest` — while every other image was pinned to a content tag.
        # That defeats the point of content tagging (same content -> same tag -> no needless
        # pod roll) and makes a "pinned" deploy manifest silently unreproducible for four of
        # its components.
        byocController = ghcrImageRef "byoc-controller" pubImages.byoc-controller-image;
        conversationController = ghcrImageRef "conversation-controller" pubImages.conversation-controller-image;
        conversationRouter = ghcrImageRef "conversation-router" pubImages.conversation-router-image;
        warmStoreController = ghcrImageRef "warm-store-controller" pubImages.warm-store-controller-image;
        dbMigrator = ghcrImageRef "agent-db-migrator" pubImages.db-migrator-image;
      };
      ghcrImageClaude = ghcrImageRef "agent-host-claude" pubImages.agent-host-image-claude;
    in
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];

      perSystem = { pkgs, system, lib, ... }:
        let
          n2c = nix2container.packages.${system}.nix2container;

          # The ACP agent the agent-host runs (first target: Goose).
          # Runs OUTSIDE the sandbox. Provider-agnostic later; selected by attr.
          #
          # DOWNSTREAM PATCH: goose's Bedrock formatter has no match arm for
          # Bedrock reasoningContent fix is now upstream as of goose-cli 1.47.0.
          # The Bedrock formatter properly handles ReasoningText and RedactedContent
          # blocks in both directions (inbound from_bedrock_content_block and outbound
          # to_bedrock_message_content). No patch needed.
          agent = pkgs.goose-cli;

          # agent-host (TypeScript): runs `goose acp` per conversation OUTSIDE the
          # sandbox; ACP<->AG-UI bridge; exec serviced via the agent-sandbox API.
          # See services/agent-host/. Pass the PATCHED `agent` (goose) so the wrapper's
          # PATH goose is the SAME derivation the image's gooseLayer bakes — otherwise
          # the closure ships goose twice (~455MB dup) and could run the unpatched one.
          # The isolated Claude Agent SDK provider (zod v4, kept out of agent-host's
          # tree). agent-host symlinks it into node_modules and imports its AcpClient.
          claudeSdkProvider = pkgs.callPackage ./services/claude-sdk-provider { };

          # The isolated marimo MCP server (notebook tools). Same isolation pattern:
          # agent-host symlinks it into node_modules and mounts its tools.
          marimoMcp = pkgs.callPackage ./services/marimo-mcp { };

          # The generated @scooter/schema package (Drizzle tables + ownership guard, from
          # lib/sql via `just db-generate`). Same isolation pattern: agent-host symlinks it
          # into node_modules and resourceMapping.ts imports its typed tables.
          scooterSchemaJs = pkgs.callPackage ./lib/ts/scooter-schema { };

          agentHost = pkgs.callPackage ./services/agent-host { inherit agent claudeSdkProvider marimoMcp scooterSchemaJs; };

          # Bring-your-own-Claude container app: drives the user's LOCAL Claude via the SAME
          # claudeSdkProvider, tunnels tool-exec to the cloud sandbox. Bakes the (unfree) claude CLI.
          remoteAgent = pkgs.callPackage ./services/remote-agent {
            inherit claudeSdkProvider;
            claude-code = pkgs.claude-code;
          };

          # agent-host OCI image.
          agentHostImageBuilder = import ./pkgs/agent-host-image {
            inherit pkgs lib n2c agentHost agent; # agent (goose) for its own layer
          };

          # Variant that also bakes the `claude` CLI, for the goose claude-code
          # provider (subscription auth). Built on demand: nix build .#agent-host-image-claude
          agentHostImageClaudeBuilder = import ./pkgs/agent-host-image {
            inherit pkgs lib n2c agentHost agent;
            withClaudeCode = true;
          };

          # Credential broker (Python/FastAPI): extensible provider/transport
          # modules. See services/broker/ + docs/BROKER.md.
          broker = pkgs.callPackage ./services/broker { inherit scooterSchema; };

          # Webhooks (Python/FastAPI): spawn agent conversations from
          # GitHub/GitLab/Jira/Slack threads. See services/webhooks/ + docs/WEBHOOKS.md.
          webhooks = pkgs.callPackage ./services/webhooks { inherit scooterSchema; };

          # Webhooks OCI image.
          webhooksImage = import ./pkgs/webhooks-image {
            inherit pkgs lib n2c webhooks;
          };

          # Generated SQLAlchemy models for the shared databases (from lib/sql via
          # `just db-generate`). Imported by the Python services; its nix build runs
          # pytest + pythonImportsCheck (proves the generated models are valid).
          scooterSchema = pkgs.callPackage ./lib/py/scooter-schema { };

          # Scheduler (Python/FastAPI): fires scheduled tasks on a cron schedule,
          # spawning a fresh conversation per run via the agent-host /agui. See
          # services/scheduler/ + todo/SCHEDULED_TASKS.md.
          scheduler = pkgs.callPackage ./services/scheduler { };

          # Scheduler OCI image.
          schedulerImage = import ./pkgs/scheduler-image {
            inherit pkgs lib n2c scheduler;
          };

          # Bring-your-own-Claude remote agent OCI image (ghcr). Bakes the UNFREE claude CLI (via
          # remoteAgent), so like the claude image its .outPath needs allowUnfree.
          remoteAgentImage = import ./pkgs/remote-agent-image {
            inherit pkgs lib n2c remoteAgent;
          };

          # Conversation CRD controller (Python): leader-elected reconcile loop that
          # assigns each Conversation CR a hostPod (agent-host replica) + reassigns on
          # pod death. Multi-replica agent-host, stage 3. See
          # todo/docs/CONVERSATION_CRD_PR1.md.
          conversationController = pkgs.callPackage ./services/conversation-controller { };

          # Conversation router (Go): fronts the agent-host Service, reverse-proxies each
          # request (HTTP/SSE/WS) to the pod owning the conversation. Multi-replica routing.
          conversationRouter = pkgs.callPackage ./services/conversation-router { };
          byocController = pkgs.callPackage ./services/byoc-controller { inherit scooterSchemaJs; };

          # Warm /nix/store PVC pool controller (Python): leader-elected reconcile loop that
          # keeps a pool of overlay-upper PVCs warmed against the current sandbox image tag
          # (top-up warm Jobs, GC retired tags, return-on-suspend, leak recovery). Runs
          # alongside the upstream agent-sandbox controller. See
          # todo/docs/WARM_STORE_PVC_MANAGER.md.
          warmStoreController = pkgs.callPackage ./services/warm-store-controller { };

          # Conversation controller OCI image.
          conversationControllerImage = import ./pkgs/conversation-controller-image {
            inherit pkgs lib n2c conversationController;
          };

          # Conversation router OCI image.
          byocControllerImage = import ./pkgs/byoc-controller-image {
            inherit pkgs lib n2c byocController;
          };
          conversationRouterImage = import ./pkgs/conversation-router-image {
            inherit pkgs lib n2c conversationRouter;
          };

          # Warm-store controller OCI image.
          warmStoreControllerImage = import ./pkgs/warm-store-controller-image {
            inherit pkgs lib n2c warmStoreController;
          };

          # Broker OCI image.
          brokerImage = import ./pkgs/broker-image {
            inherit pkgs lib n2c broker;
          };

          # Shared-DB migration Job image: Atlas CLI + lib/sql migrations + a driver
          # that `atlas migrate apply --baseline`s each per-service database. See
          # modules/db-migrate.nix.
          dbMigratorImage = import ./pkgs/db-migrator-image {
            inherit pkgs lib n2c;
          };

          # Broker tools (agent-broker / git-credential-broker / scooter-aws*),
          # prebuilt — always needed, so baked into the sandbox image (the read-only
          # lower of its overlay store). The sandbox-os config callPackages these
          # directly (carry-over.nix), one source of truth (pkgs/broker-tools).
          brokerTools = pkgs.callPackage ./pkgs/broker-tools { };

          # nix-stubs' lib for this system (mkLazyPackage / mkOverlay) — passed into
          # the sandbox-os build so its modules can declare lazy tool shims.
          nixStubsLib = nix-stubs.lib.${system};

          # The uv-nix uv (patched for Nix) — backs the in-pod marimo so science deps
          # install + import. Passed into the sandbox-os build for marimo.nix.
          uvNix = uv-nix.packages.${system}.default;

          # The NixOS dev-environment sandbox image (systemd PID 1, lazy tools,
          # services). Built from the shared modules/sandbox-os config. The local-overlay
          # writable /nix/store is ALWAYS ON in this image (pkgs/sandbox-os sets
          # programs.overlayStore.enable) — there is no longer a separate read-only-store
          # variant; the writable store is required for runtime tool-install + re-converge.
          sandboxOsImage = import ./pkgs/sandbox-os {
            inherit pkgs lib n2c nixStubsLib uvNix;
          };

          # TypeScript UI (assistant-ui + AG-UI runtime). See ui/.
          ui = pkgs.callPackage ./ui { };

          # UI OCI image: nginx serving the static build + proxying the agent-host.
          uiImage = import ./pkgs/ui-image {
            inherit pkgs lib n2c ui;
          };

          # Render the platform manifests (namespace, agent-host Deployment + RBAC) with
          # kubenix. `mkPlatform` takes the full `agentSandbox` config for a render, so
          # each flavor declares its own images AND agent config — the e2e flavor is a
          # dummy agent with test hooks; the ghcr flavor is a real production deploy.
          # `extraModules` is how a TEST render opts into test-only overrides (modules/testing.nix).
          # A deploy render passes none, so it cannot enable a dummy agent or an unauthenticated
          # test webhook even by setting a stray boolean — the options only exist with the module.
          mkPlatformWith = extraModules: agentSandbox: kubenix.evalModules.${system} {
            module = { kubenix, ... }: {
              imports = [ ./modules/platform.nix ] ++ extraModules;
              kubenix.project = "agent-sandbox";
              kubernetes.version = "1.31";
              inherit agentSandbox;
            };
          };
          mkPlatform = mkPlatformWith [ ];
          mkTestPlatform = mkPlatformWith [ ./modules/testing.nix ];

          # E2E/cluster-test render (`nix build .#platform-manifests`): the DUMMY agent +
          # test providers, and images SIDE-LOADED into k3s so it uses bare local names
          # (registryPrefix "" overrides the module's ghcr default). This is NOT a deploy
          # manifest — it's the config the Tier-2 cluster + Tier-3 e2e suites apply.
          # Shared by the side-load render (`platform`, bare names) and the k3d-registry
          # render (`platformK3d`, content-tagged refs) — ONE test config, two image
          # sourcing strategies.
          # The full test-platform config as data, so a variant (e.g. the event-backfill
          # e2e render below) can `recursiveUpdate` it instead of duplicating every knob.
          mkTestPlatformConfig = imgs: {
            registryPrefix = "";
            agentHostImage = imgs.agentHost;
            sandboxImage = imgs.sandboxOs;
            uiImage = imgs.ui;
            conversationController.image = imgs.conversationController;
            conversationController.routerImage = imgs.conversationRouter;
            agent.skills = scooterSkills; # ship the ./skills/*.md set
            # TEST-ONLY overrides come from modules/testing.nix, which only mkTestPlatform imports.
            testing.enable = true;
            # No migration Job in the cluster/e2e renders: the services still self-create
            # their tables, so migrations aren't needed for tests, and this keeps the
            # agent-db-migrator image out of the side-load/k3d push set.
            dbMigrate.enable = false;
            # The cross-pod history mirror, backed by the single-node hostPath escape hatch
            # (k3d's local-path provisioner has no RWX; a hostPath PV binds the RWX claim and
            # every pod shares the one node's directory — the same mechanism odin uses).
            #
            # This USED to be disabled, with the note "a single-node e2e doesn't need
            # cross-pod revival" — written before the CI job forced CONVERSATION_POD_CAP=1 +
            # 3 replicas, which makes cross-pod reassignment CONSTANT. With no mirror, a
            # conversation reassigned mid-run could never be revived on its new owner: the
            # ownership fence truncated its log (by design) and the new pod had nothing to
            # hydrate from, so the UI sat at "Working…" forever. Found by the Tier-2
            # browser tests.
            conversationController.historyMirror = {
              enable = true;
              hostPath = "/var/lib/scooter-e2e-history";
            };
            broker = {
              enable = true;
              image = imgs.broker;
              testProvider = true; # whoami provider for the credential e2e
            };
            webhooks = {
              enable = true;
              image = imgs.webhooks;
              # testWebhook comes from modules/testing.nix — not repeated here.
            };
          };
          mkTestPlatformImages = imgs: mkTestPlatform (mkTestPlatformConfig imgs);
          platform = mkTestPlatformImages {
            agentHost = "agent-host:latest";
            sandboxOs = "agent-sandbox-os:latest";
            ui = "agent-sandbox-ui:latest";
            broker = "agent-broker:latest";
            webhooks = "agent-webhooks:latest";
            conversationController = "conversation-controller:latest";
            conversationRouter = "conversation-router:latest";
          };
          # `nix build .#platform-manifests-k3d`: the SAME test platform, images pulled
          # from the k3d-attached registry by CONTENT TAG (see k3dImages). No side-load.
          platformK3d = mkTestPlatformImages k3dImages;

          # `nix build .#platform-manifests-k3d-backfill`: the k3d test platform with the
          # one-shot event backfill turned ON (and the mirror PVC retained, which the module's
          # assert requires). The Tier-2 event-backfill e2e reads the rendered Job out of this
          # (real k3d image ref + agent_host DB wiring) and applies its own seeded instance —
          # so the test exercises the ACTUAL module output, not a hand-built copy that could drift.
          platformK3dBackfill = mkTestPlatform (lib.recursiveUpdate (mkTestPlatformConfig k3dImages) {
            eventBackfill.enable = true;
            conversationController.historyMirror.retainForMigration = true;
          });

          # GHCR render (`nix build .#platform-manifests-ghcr`): the REAL production deploy
          # manifest — the actual agent (fakeAgent = false), NO test providers/webhooks,
          # and every image pinned to its published CONTENT TAG (ghcrImages) so the manifest
          # points at the exact tags the publish-images workflow pushed (same content → same
          # tag → no needless pod roll). Crucially these refs are pure TEXT (contentTag
          # discards the outPath string context), so threading them in does NOT drag the
          # images into the manifest build — the render stays a cheap YAML writeText (proven:
          # the built YAML has zero image references, and the .drv has empty inputDrvs for
          # the image paths). registryPrefix stays the module default (ghcr.io/chadac/
          # scooter/) but every image below is pinned explicitly, so the prefix only shows
          # through for third-party images we don't own.
          platformGhcr = mkPlatform {
            agent.skills = scooterSkills; # ship the ./skills/*.md set
            fakeAgent = false; # the real agent — this is a production deploy
            agentHostImage = ghcrImages.agentHost;
            sandboxImage = ghcrImages.sandboxOs;
            uiImage = ghcrImages.ui;
            broker = {
              enable = true;
              image = ghcrImages.broker;
              # NO testProvider — real deploys wire real credential providers.
            };
            webhooks = {
              enable = true;
              image = ghcrImages.webhooks;
              # NO testWebhook — the /webhooks/test spawn endpoint is e2e-only.
            };
            # The CONTROLLERS, pinned like everything else. Without these four the render
            # fell back to their module defaults (`:latest`), so a manifest that advertises
            # content-pinned images silently shipped four of its components unpinned — no
            # reproducibility, and a pod roll on every deploy whether or not they changed.
            conversationController.image = ghcrImages.conversationController;
            conversationController.routerImage = ghcrImages.conversationRouter;
            warmStore.image = ghcrImages.warmStoreController;
            byoc.image = ghcrImages.byocController;
          };

          # Tier-1-style config-correctness tests for the dev-environment sandbox:
          # each boots the sandbox-os NixOS config in a QEMU VM with real systemd.
          # Linux-only (nixosTest needs KVM). Exposed as checks so `nix flake
          # check` runs them. See nixos-tests/ + docs/DEV_ENVIRONMENT*.
          devEnvTests =
            if pkgs.stdenv.isLinux
            then import ./nixos-tests { inherit pkgs lib; }
            else { };
        in
        {
          packages = {
            # The sandbox is the NixOS systemd-PID-1 dev image (the legacy generic
            # pkgs/sandbox-image was retired).
            default = sandboxOsImage.image;

            # `nix build .#options-doc` -> the agentSandbox.* option reference as JSON,
            # rendered FROM the module system (nixosOptionsDoc), so the published reference can
            # never drift from the code. JSON rather than CommonMark on purpose: the docs build
            # splits it into one page PER NAMESPACE (so mkdocs search scores each separately
            # instead of returning one 4k-line document) and feeds the client-side filter table.
            # See docs/gen_options.py.
            options-doc =
              (pkgs.nixosOptionsDoc {
                options = { agentSandbox = (mkPlatform { }).options.agentSandbox; };
                warningsAreErrors = false;
                # Repo-relative declaration links instead of /nix/store paths.
                transformOptions = opt: opt // {
                  declarations = map
                    (d:
                      let str = toString d;
                          m = builtins.match ".*/(modules/.*)" str;
                      in if m != null
                         then { name = builtins.head m; url = "https://github.com/chadac/scooter/blob/main/${builtins.head m}"; }
                         else d)
                    opt.declarations;
                };
              }).optionsJSON;

            inherit agentHost ui broker webhooks scheduler;
            conversation-controller = conversationController;
            conversation-router = conversationRouter;
            byoc-controller = byocController;
            warm-store-controller = warmStoreController;
            inherit agent; # the ACP agent (goose), exposed for the agent-host
            inherit marimoMcp; # the isolated marimo MCP server (buildable/inspectable)

            # nix build .#sandbox-os-image  ->  NixOS systemd-PID-1 dev sandbox with the
            # writable local-overlay Nix store ALWAYS ON (the sole sandbox image now).
            sandbox-os-image = sandboxOsImage.image;

            # The broker tools (agent-broker / git-credential-broker / scooter-aws*),
            # prebuilt; baked into the sandbox-os image via the brokerTools overlay.
            broker-tools = brokerTools.agent-broker;

            # nix build .#broker-image  ->  broker OCI image
            broker-image = brokerImage.image;

            # nix build .#db-migrator-image  ->  shared-DB migration Job image
            db-migrator-image = dbMigratorImage.image;

            # nix build .#webhooks-image  ->  webhooks OCI image
            webhooks-image = webhooksImage.image;

            # nix build .#scheduler-image  ->  scheduler OCI image
            scheduler-image = schedulerImage.image;

            # nix build .#scooter-schema  ->  generated SQLAlchemy models (runs pytest)
            scooter-schema = scooterSchema;

            # nix build .#scooter-schema-js  ->  generated Drizzle schema package (tsc)
            scooter-schema-js = scooterSchemaJs;

            # nix build .#remote-agent  ->  the BYO-Claude container app (bin)
            remote-agent = remoteAgent;
            # nix build .#remote-agent-image  ->  BYO-Claude remote agent OCI image (ghcr; unfree claude)
            remote-agent-image = remoteAgentImage.image;

            # nix build .#conversation-controller-image  ->  controller OCI image
            conversation-controller-image = conversationControllerImage.image;

            # nix build .#conversation-router-image  ->  router OCI image
            conversation-router-image = conversationRouterImage.image;
            # nix build .#byoc-controller-image  ->  BYOC controller OCI image
            byoc-controller-image = byocControllerImage.image;

            # nix build .#warm-store-controller-image  ->  warm-store controller OCI image
            warm-store-controller-image = warmStoreControllerImage.image;

            # nix build .#agent-host-image  ->  agent-host OCI image
            agent-host-image = agentHostImageBuilder.image;
            # nix build .#agent-host-image-claude  ->  + the claude CLI (claude-code provider)
            agent-host-image-claude = agentHostImageClaudeBuilder.image;

            # nix build .#ui-image  ->  UI (nginx + static build) OCI image
            ui-image = uiImage.image;

            # nix build .#platform-manifests  ->  multi-doc YAML for kubectl apply
            # (e2e/local flavor: bare side-loaded image names).
            platform-manifests = platform.config.kubernetes.resultYAML;

            # The k3d-registry render + the attr->ref push map for the CI/e2e-full flow.
            platform-manifests-k3d = platformK3d.config.kubernetes.resultYAML;
            # The k3d test platform + event backfill enabled — the Tier-2 e2e extracts the
            # rendered agent-event-backfill Job from this YAML (see platformK3dBackfill).
            platform-manifests-k3d-backfill = platformK3dBackfill.config.kubernetes.resultYAML;
            k3d-image-refs = pkgs.writeText "k3d-image-refs.json" (builtins.toJSON k3dImagePushMap);

            # nix build .#platform-manifests-ghcr  ->  the same manifests with every image
            # pinned to its published ghcr CONTENT TAG (from ghcrImages). This is the
            # reproducible deploy render — no `nix build .#ghcr-image-refs` + manual
            # per-image override needed. The content tags are pure text (contentTag
            # discards the outPath string context), so this render does NOT build any
            # image — it's still just a YAML writeText.
            platform-manifests-ghcr = platformGhcr.config.kubernetes.resultYAML;

            # `nix build .#example-manifests` -> the YAML the EXAMPLE config renders. The
            # example is the maintained "every feature enabled" reference the docs point at,
            # so CI applies THIS (server-side dry-run, real API validation) rather than only
            # asserting it evaluates: a config that renders but is invalid Kubernetes — a bad
            # field, a malformed probe, a resource the apiserver rejects — is exactly what a
            # copy-pasting deployer would hit first.
            example-manifests =
              (kubenix.evalModules.${system} {
                module = { kubenix, ... }: {
                  imports = [ ./modules/platform.nix ./examples/kubenix-config.nix ];
                  kubenix.project = "agent-sandbox";
                  kubernetes.version = "1.31";
                };
              }).config.kubernetes.resultYAML;

            # nix build .#ghcr-image-refs  ->  JSON { <name> = "ghcr.io/…:<content-tag>" }
            # The content-tagged ghcr refs for every published image, computed from
            # the derivation outPath at EVAL time (no build). Identical to what the
            # publish-images workflow pushes. A deploy config (or the ghcr platform
            # module default) reads these so the manifest points at the exact pushed
            # tag — same content → same tag → no needless pod roll.
            ghcr-image-refs = pkgs.writeText "ghcr-image-refs.json" (builtins.toJSON ghcrImages);
          };

          # Dev shell: everything needed to build, test (Tier 1-3), and drive a
          # local cluster. Defined in ./nix/devshell.nix; `nix develop` or
          # `.envrc` (`use flake`) via direnv both use it.
          devShells.default = import ./nix/devshell.nix { inherit pkgs conversationRouter; };

          checks = {
            inherit agentHost ui;
          } // devEnvTests;
        };

      flake = {
        # The built-in agent skills as a `filename -> content` attrset, for a host
        # flake to thread into `agentSandbox.agent.skills` (so a custom deploy ships
        # the same skills the default render does). e.g.
        #   agentSandbox.agent.skills = scooter.lib.scooterSkills;
        lib.scooterSkills = scooterSkills;

        # kubenix modules: SandboxTemplate / SandboxWarmPool / Sandbox generators
        # (+ gateway/broker/webhooks Deployments, post-PoC). See modules/.
        kubenixModules.agentSandbox = ./modules;
        # The bare platform module — image refs default to the floating
        # `${registryPrefix}<name>:latest`. Import this if you want to pin images
        # yourself. `platform` keeps the raw module; `default` (below) adds the
        # content pins so the CONVENTIONAL entry point is reproducible by default.
        kubenixModules.platform = ./modules/platform.nix;
        # The conventional entry point: the platform module WITH the published-image
        # defaults set to their CONTENT TAGS (ghcrImages), not :latest. So a host
        # flake that imports scooter.kubenixModules.default and renders gets a
        # reproducible pin out of the box — same content → same tag → no needless pod
        # roll — instead of a floating :latest. The tags are x86_64-pinned pure text
        # (see ghcrImages), so this module stays system-independent. Override any
        # agentSandbox.*Image / registryPrefix to ship elsewhere.
        kubenixModules.default = { lib, ... }: {
          imports = [ ./modules/platform.nix ];
          # Per-leaf mkDefault so a consumer's explicit override of any single image
          # still wins (a set-level mkDefault would clobber sibling agentSandbox config).
          config.agentSandbox = {
            agentHostImage = lib.mkDefault ghcrImages.agentHost;
            sandboxImage = lib.mkDefault ghcrImages.sandboxOs;
            uiImage = lib.mkDefault ghcrImages.ui;
            broker.image = lib.mkDefault ghcrImages.broker;
            webhooks.image = lib.mkDefault ghcrImages.webhooks;
            scheduler.image = lib.mkDefault ghcrImages.scheduler;
            dbMigrate.image = lib.mkDefault ghcrImages.dbMigrator;
          };
        };
      };
    };
}
