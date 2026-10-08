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
      # The PLATFORM's agent skills — the ones that document no contrib, so nothing
      # gates them. A skill for a contrib lives in that contrib and is gated on it
      # (contrib/<name>/contrib.nix -> modules/platform.nix), never passed through here.
      #
      # Every ./skills/*.md read into the
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

      # Tags hash the x86_64 image -- publish-images runs there, so a local-arch
      # hash was never pushed. Only the TAG is pinned: the package stays the local
      # build, and a tag is discarded-context text, so this is no build dep.
      pubImages = self.packages.x86_64-linux;
      imagePackageConfig = { lib, config, ... }: {
        config.scooter.images = lib.mapAttrs
          (name: attr: { tag = lib.mkForce (config.scooter.imagesContentTag pubImages.${attr}); })
          imageAttrs;
      };

      # image name -> the packages attr publish-images pushes.
      imageAttrs = {
        agent-host = "agent-host-image";
        agent-sandbox-ui = "ui-image";
        agent-broker = "broker-image";
        agent-scheduler = "scheduler-image";
        agent-webhooks = "webhooks-image";
        agent-sandbox-os = "sandbox-os-image";
        agent-db-migrator = "db-migrator-image";
        byoc-controller = "byoc-controller-image";
        conversation-controller = "conversation-controller-image";
        conversation-router = "conversation-router-image";
        warm-store-controller = "warm-store-controller-image";
      };

      # k3d publishes to a registry k3d creates; `.localhost` resolves on the
      # host (skopeo pushes from /nix/store) and in-cluster via docker DNS.
      k3dRegistry = "k3d-scooter-reg.localhost:5800/";

      # The images the k3d/e2e render pushes and pulls by content tag.
      k3dPushAttrs = {
        agent-host-image = "agent-host";
        ui-image = "agent-sandbox-ui";
        broker-image = "agent-broker";
        webhooks-image = "agent-webhooks";
        sandbox-os-image = "agent-sandbox-os";
        conversation-controller-image = "conversation-controller";
        conversation-router-image = "conversation-router";
        db-migrator-image = "agent-db-migrator";
      };

      # ghcr-image-refs' camelCase keys; server-config reads them by name.
      ghcrRefKeys = {
        agentHost = "agent-host";
        ui = "agent-sandbox-ui";
        broker = "agent-broker";
        scheduler = "agent-scheduler";
        webhooks = "agent-webhooks";
        sandboxOs = "agent-sandbox-os";
        byocController = "byoc-controller";
        conversationController = "conversation-controller";
        conversationRouter = "conversation-router";
        warmStoreController = "warm-store-controller";
        dbMigrator = "agent-db-migrator";
      };
    in
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];

      perSystem = { pkgs, system, lib, ... }:
        let
          n2c = nix2container.packages.${system}.nix2container;

          # The ACP agent the agent-host runs (first target: Goose).
          # Runs OUTSIDE the sandbox. Provider-agnostic later; selected by attr.
          #
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

          # Variant that also bakes the `claude` CLI, for the goose claude-code
          # provider (subscription auth). Built on demand: nix build .#agent-host-image-claude
          agentHostImageClaudeBuilder = import ./pkgs/agent-host-image {
            inherit pkgs lib n2c agentHost agent;
            withClaudeCode = true;
          };

          # The service apps with NO contribs. These exist to break the cycle:
          # the shipped broker/webhooks below depend on `contribs`, and a
          # contrib's tests take the real service as a check input — so the
          # thing they take must be the contrib-free build, not the shipped one.
          brokerBase = pkgs.callPackage ./services/broker { inherit scooterSchema scooterLib scooterBrokerLib; };
          webhooksBase = pkgs.callPackage ./services/webhooks { inherit scooterSchema scooterLib scooterWebhooksLib; };

          # Contrib modules: self-contained integration packages discovered via
          # entry points (broker providers / webhooks handlers). Built once per
          # target service and bucketed, so each service image gets only the
          # contribs — and only the extension surface — it actually scans.
          # See contrib/ + contrib/README.md.
          # THE ONE PLACE that names .github/deployment: nothing under contrib/,
          # pkgs/ or modules/ may, because those trees are vended.
          deploymentModules = [ ./.github/deployment/config.nix ];
          shippedContribs = (import ./.github/deployment/config.nix).contribs;

          contribs = pkgs.callPackage ./contrib {
            inherit deploymentModules;
            broker = brokerBase;
            webhooks = webhooksBase;
            inherit scooterBrokerLib scooterWebhooksLib;
          };

          # The set CI tests: adds the contribs that ship nowhere, which are
          # otherwise unbuilt. mkForce because they assert enable = false, and two
          # plain definitions conflict. Why: PR #585.
          contribsWithExamples = contribs.withModules [{
            contribs.echo.enable = pkgs.lib.mkForce true;
          }];

          # Keyed <name>-<service>: both variants share a derivation name, so a
          # name-keyed consumer would collapse them. Why: PR #573.
          contribsAll = pkgs.linkFarm "contribs-all"
            (pkgs.lib.mapAttrsToList (name: path: { inherit name path; })
              contribsWithExamples.all);

          # Credential broker (Python/FastAPI): extensible provider/transport
          # modules, plus the contribs that target it. See services/broker/ +
          # docs/BROKER.md.
          broker = brokerBase.override { contribs = contribs.broker; };

          # Webhooks (Python/FastAPI): spawn agent conversations from
          # GitHub/GitLab/Jira/Slack threads. See services/webhooks/ + docs/WEBHOOKS.md.
          webhooks = webhooksBase.override { contribs = contribs.webhooks; };

          # Webhooks OCI image.

          # Generated SQLAlchemy models for the shared databases (from lib/sql via
          # `just db-generate`). Imported by the Python services; its nix build runs
          # pytest + pythonImportsCheck (proves the generated models are valid).
          scooterSchema = pkgs.callPackage ./lib/py/scooter-schema { };

          # Shared Python libraries (the lib split). scooter_lib is service-agnostic;
          # the two extension-surface libs hold exactly what a provider/handler
          # composes, so a contrib build-depends on the lib instead of the service
          # app (breaking the app<->contrib cycle). See lib/py/*/ + the PR boundary.
          scooterLib = pkgs.callPackage ./lib/py/scooter-lib { };
          scooterBrokerLib = pkgs.callPackage ./lib/py/scooter-broker-lib { inherit scooterLib; };
          scooterWebhooksLib = pkgs.callPackage ./lib/py/scooter-webhooks-lib { inherit scooterLib scooterSchema; };

          # Scheduler (Python/FastAPI): fires scheduled tasks on a cron schedule,
          # spawning a fresh conversation per run via the agent-host /agui. See
          # services/scheduler/ + todo/SCHEDULED_TASKS.md.
          scheduler = pkgs.callPackage ./services/scheduler { };

          # Scheduler OCI image.

          # Bring-your-own-Claude remote agent OCI image (ghcr). Bakes the UNFREE claude CLI (via
          # remoteAgent), so like the claude image its .outPath needs allowUnfree.

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

          # Conversation router OCI image.

          # Warm-store controller OCI image.

          # Broker OCI image.

          # Shared-DB migration Job image: Atlas CLI + lib/sql migrations + a driver
          # that `atlas migrate apply --baseline`s each per-service database. See
          # modules/db-migrate.nix.

          # Broker tools (agent-broker / git-credential-broker),
          # prebuilt — always needed, so baked into the sandbox image (the read-only
          # lower of its overlay store). The sandbox-os config callPackages these
          # directly (carry-over.nix), one source of truth (pkgs/broker-tools).
          brokerTools = pkgs.callPackage ./pkgs/broker-tools { };

          # Applied HERE, at pkgs construction, not through `nixpkgs.overlays`:
          # pkgs/sandbox-os builds the system with `pkgs.nixos`, which sets
          # `nixpkgs.pkgs` and conflicts with the overlays option. The in-pod
          # re-converge is the mirror case (modules/sandbox-os/stub-set.nix).
          stubOverlay = import ./modules/sandbox-os/stub-overlay.nix {
            lockLib = nix-stubs.lib;
            flakeLock = ./flake.lock;
            nix-stubs = nix-stubs.packages.${system}.nix-stubs;
          };

          # A pkgs with the stubs applied, for the sandbox image ONLY. Scoped
          # deliberately: overlaying the repo-wide pkgs would hand a shim to every
          # other build here, and nothing outside the sandbox wants one.
          sandboxPkgs = import nixpkgs { inherit system; overlays = [ stubOverlay ]; };

          # The uv-nix uv (patched for Nix) — backs the in-pod marimo so science deps
          # install + import. Passed into the sandbox-os build for marimo.nix.
          uvNix = uv-nix.packages.${system}.default;

          # The NixOS dev-environment sandbox image (systemd PID 1, lazy tools,
          # services). Built from the shared modules/sandbox-os config. The local-overlay
          # writable /nix/store is ALWAYS ON in this image (pkgs/sandbox-os sets
          # programs.overlayStore.enable) — there is no longer a separate read-only-store
          # variant; the writable store is required for runtime tool-install + re-converge.
          sandboxOsImage = import ./pkgs/sandbox-os {
                inherit deploymentModules;
            inherit lib n2c uvNix;
            pkgs = sandboxPkgs;
            # For the in-pod re-converge: it vendors these so a self-modify can
            # rebuild the stub overlay instead of re-fattening every stubbed tool.
            nixStubs = {
              src = nix-stubs;
              package = nix-stubs.packages.${system}.nix-stubs;
            };
          };

          # TypeScript UI (assistant-ui + AG-UI runtime). See ui/.
          # The contrib set is NOT an input here: its manifest is a file nginx serves
          # and the UI fetches, so changing that set relinks an image layer instead of
          # re-running vite. See contrib/ui-manifest.nix.
          ui = pkgs.callPackage ./ui { };

          # UI OCI image: nginx serving the static build + proxying the agent-host,
          # plus the contribs' manifest at /contrib/manifest.json.

          # Render the platform manifests (namespace, agent-host Deployment + RBAC) with
          # kubenix. `mkPlatform` takes the full `scooter` config for a render, so
          # each flavor declares its own images AND agent config — the e2e flavor is a
          # dummy agent with test hooks; the ghcr flavor is a real production deploy.
          # `extraModules` is how a TEST render opts into test-only overrides (modules/testing.nix).
          # A deploy render passes none, so it cannot enable a dummy agent or an unauthenticated
          # test webhook even by setting a stray boolean — the options only exist with the module.
          #
          # Each image declares its own scooter.images entry, beside what it builds.
          # agent-host-image-claude is excluded: it would redefine agent-host.
          # Each image.nix is a function of its build inputs returning a module that
          # declares its own scooter.images entry.
          imageModules = map (m: import m imageArgs) [
            ./pkgs/agent-host-image/image.nix
            ./pkgs/ui-image/image.nix
            ./pkgs/broker-image/image.nix
            ./pkgs/scheduler-image/image.nix
            ./pkgs/webhooks-image/image.nix
            ./pkgs/db-migrator-image/image.nix
            ./pkgs/byoc-controller-image/image.nix
            ./pkgs/conversation-controller-image/image.nix
            ./pkgs/conversation-router-image/image.nix
            ./pkgs/warm-store-controller-image/image.nix
            ./pkgs/remote-agent-image/image.nix
          ] ++ [ sandboxOsImage.module imagePackageConfig ];

          # Build inputs the image modules take as ordinary arguments.
          imageArgs = {
            inherit pkgs lib n2c agent agentHost broker webhooks scheduler ui
              remoteAgent byocController conversationController conversationRouter
              warmStoreController;
            contribManifest = contribs.uiManifest;
          };

          # `contribs` is at the module root, not under `scooter`.
          mkPlatformWith = extraModules: full:
            let scooter = builtins.removeAttrs full [ "contribs" ];
            in kubenix.evalModules.${system} {
              module = { kubenix, ... }: {
                imports = [ ./modules/platform.nix ] ++ imageModules ++ extraModules;
                kubenix.project = "agent-sandbox";
                kubernetes.version = "1.31";
                contribs = full.contribs or { };
                inherit scooter;
              };
            };
          # THE VENDED ENTRY POINT. Takes modules, returns the eval -- so a
          # consumer never imports kubenix or the image modules itself.
          # Takes the same { module = ...; } kubenix takes, so a call site only
          # swaps the function name.
          evalPlatform = { module }: kubenix.evalModules.${system} {
            module = { kubenix, ... }: {
              imports = [ ./modules/platform.nix module ] ++ imageModules;
              kubenix.project = "agent-sandbox";
              kubernetes.version = "1.31";
            };
          };

          mkPlatform = mkPlatformWith [ ];

          # The derivations, read back out of the evaluated module tree.
          builtImages = (mkPlatform { }).config.scooter.images;
          mkTestPlatform = mkPlatformWith [ ./modules/testing.nix ];

          # What the test renders ship. `enable` defaults false, so this is the
          # opt-in list; it names exactly what the opt-out list left on before.
          testContribs = lib.genAttrs
            [ "aws" "jira" "kagi" "duckduckgo" ]
            (_: { enable = true; });

          # E2E/cluster-test render (`nix build .#platform-manifests`): the DUMMY agent +
          # test providers, and images SIDE-LOADED into k3s so it uses bare local names
          # (registryPrefix "" overrides the module's ghcr default). This is NOT a deploy
          # manifest — it's the config the Tier-2 cluster + Tier-3 e2e suites apply.
          # Shared by the side-load render (`platform`, bare names) and the k3d-registry
          # render (`platformK3d`, content-tagged refs) — ONE test config, two image
          # sourcing strategies.
          # The full test-platform config as data, so a variant (e.g. the event-backfill
          # e2e render below) can `recursiveUpdate` it instead of duplicating every knob.
          mkTestPlatformConfig = prefix: {
            registryPrefix = prefix;
            agent.skills = scooterSkills; # ship the ./skills/*.md set
            # TEST-ONLY overrides come from modules/testing.nix, which only mkTestPlatform imports.
            testing.enable = true;
            # RUN the migration Job in the cluster/e2e renders. This USED to be disabled with
            # the note "the services still self-create their tables, so migrations aren't
            # needed for tests" — that stopped being true when agent-host's metadata stores
            # dropped their inline DDL (#425). With no migrator, NOTHING creates the
            # `conversations`/jobs/events/assets schema, so agent-host crash-loops at hydrate
            # on `relation "conversations" does not exist`, agent-host never goes Ready, the
            # router's /healthz proxy to it fails, and every e2e-full spec dies at
            # `apply platform + smoke`. The migrator image is now in the side-load/k3d push
            # sets (flake k3dImagePushMap + justfile + ci.yml) so this Job's image exists.
            dbMigrate.enable = true;
            # Assets PVC on the single-node k3d hostPath escape hatch. #471 made this PVC
            # ReadWriteMany (all agent-host replicas write assets), but k3d's only provisioner
            # (local-path) is RWO-only, so an RWX claim stays Pending forever and agent-host
            # never schedules. Same fix as historyMirror.hostPath: a hostPath PV binds the RWX
            # claim on the one node every pod shares.
            conversationController.assets.hostPath = "/var/lib/scooter-e2e-assets";
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
              testProvider = true; # whoami provider for the credential e2e
            };
            # testWebhook comes from modules/testing.nix — not repeated here.
            webhooks.enable = true;
            # e2e configures no credentials; drop contribs needing one.
            contribs = testContribs;
          };
          mkTestPlatformImages = prefix: mkTestPlatform (mkTestPlatformConfig prefix);
          # Side-loaded into k3s, so bare names on :latest — no registry to tag against.
          platform = mkTestPlatform (mkTestPlatformConfig "" // {
            # Side-loaded: bare names on :latest, overriding the x86_64 tag pin.
            images = builtins.mapAttrs (_: _: { tag = lib.mkOverride 40 "latest"; }) builtImages;
          });
          # `nix build .#platform-manifests-k3d`: the SAME test platform, pulled from
          # the k3d registry by content tag. No side-load.
          platformK3d = mkTestPlatformImages k3dRegistry;

          # `nix build .#platform-manifests-k3d-backfill`: the k3d test platform with the
          # one-shot event backfill turned ON (and the mirror PVC retained, which the module's
          # assert requires). The Tier-2 event-backfill e2e reads the rendered Job out of this
          # (real k3d image ref + agent_host DB wiring) and applies its own seeded instance —
          # so the test exercises the ACTUAL module output, not a hand-built copy that could drift.
          platformK3dBackfill = mkTestPlatform (lib.recursiveUpdate (mkTestPlatformConfig k3dRegistry) {
            eventBackfill.enable = true;
            conversationController.historyMirror.retainForMigration = true;
          });

          # GHCR render (`nix build .#platform-manifests-ghcr`): the REAL production
          # deploy — real agent, no test providers, every image on its published
          # content tag. Refs are pure text, so this builds no image.
          platformGhcr = mkPlatform {
            agent.skills = scooterSkills; # ship the ./skills/*.md set
            fakeAgent = false; # the real agent — this is a production deploy
            broker.enable = true; # real deploys wire real credential providers
            webhooks.enable = true; # no testWebhook — /webhooks/test is e2e-only
            # Bare render: platform only, no integrations.
            contribs = testContribs;
          };

          # attr -> k3d ref, for the push script. Read out of the k3d render so a
          # pushed tag and the manifest's tag cannot disagree.
          k3dImageRefs = platformK3d.config.scooter.images;
          k3dPushRefs = builtins.mapAttrs (_: n: k3dImageRefs.${n}.ref) k3dPushAttrs;

          # The camelCase refs server-config reads, from the ghcr render.
          ghcrImageRefs = platformGhcr.config.scooter.images;
          ghcrRefs = builtins.mapAttrs (_: n: ghcrImageRefs.${n}.ref) ghcrRefKeys;

          # Tier-1-style config-correctness tests for the dev-environment sandbox:
          # each boots the sandbox-os NixOS config in a QEMU VM with real systemd.
          # Linux-only (nixosTest needs KVM). Exposed as checks so `nix flake
          # check` runs them. See nixos-tests/ + docs/DEV_ENVIRONMENT*.
          devEnvTests =
            if pkgs.stdenv.isLinux
            then import ./nixos-tests { inherit pkgs lib stubOverlay deploymentModules; }
            else { };

          # The contrib sandbox surface, without building an image. Three links, and
          # the middle one is what fails silently if it breaks: a contrib whose module
          # reached the image but not the in-pod rebuild is a `scooter-rebuild switch`
          # that reports success and drops its tools. echo is the fixture — it ships
          # nowhere, so it is the only contrib that can carry one until aws moves.
          # See #599.
          contribSandbox =
            let
              # What this repo ships first; a fixture layers on top.
              derive = extraModules: import ./contrib/sandbox-modules.nix {
                inherit lib;
                extraModules = deploymentModules ++ extraModules;
              };
              # echo pins `enable = false` (it must never ship), so the fixture
              # overrides rather than merges.
              withEcho = derive [{ contribs.echo.enable = lib.mkForce true; }];
              # Just the fixture: pkgs/sandbox-os already carries the contribs the
              # repo enables, so passing the whole list would duplicate aws.
              echoOnly = lib.subtractLists (derive [ ]).treeRelative withEcho.treeRelative;
              # Through `extraModuleFiles`, the arg a deployment layering its own
              # modules into the image should use: imported AND carried into the
              # re-converge list. Passing the fixture the other way (`extraModules`)
              # would leave it out of that list, which is the bug #717 closed.
              sandboxWithEcho = import ./pkgs/sandbox-os {
                inherit deploymentModules;
                inherit lib n2c uvNix;
                pkgs = sandboxPkgs;
                nixStubs = {
                  src = nix-stubs;
                  package = nix-stubs.packages.${system}.nix-stubs;
                };
                extraModuleFiles = echoOnly;
              };
              # Reached through the CONFIG, not re-derived here, so this fails if the
              # image stops baking the tree the in-pod rebuild reads.
              tree = lib.head (lib.filter
                (d: lib.hasSuffix "-sandbox-os-src" (toString d))
                sandboxWithEcho.nixos.config.system.extraDependencies);

              # The image as it actually SHIPS — no fixture layered on. aws's sandbox
              # half is the only contrib in it.
              shipped = import ./pkgs/sandbox-os {
                inherit deploymentModules;
                inherit lib n2c uvNix;
                pkgs = sandboxPkgs;
                nixStubs = {
                  src = nix-stubs;
                  package = nix-stubs.packages.${system}.nix-stubs;
                };
              };
              # The baked re-converge list, as the image renders it: resolved store
              # paths under the vendored tree. Read through the CONFIG so this fails
              # if the image stops rendering it at all.
              listFile = sandboxWithEcho.nixos.config.environment.etc."scooter/reconverge-modules.json".source;
            in
            # 1. A derived module is real sandbox config, not just a valid file.
            assert sandboxWithEcho.nixos.config.environment.etc ? "scooter/contrib-echo";
            # 2. The fixture reached the image through `extraModuleFiles`, which is
            # also what the re-converge replays — so it is exactly the disabled
            # contrib and nothing else. (1) proves it landed; this proves HOW.
            assert echoOnly == [ "contrib/echo/sandbox.nix" ];
            # 3. …and with no fixture, the carried list is EXACTLY what the deriver
            # returns for this source. (1) + (2) + (3) is the whole chain: source ->
            # list -> image -> the list a self-modify replays.
            assert shipped.nixos.config.programs.scooterModule.extraReconvergeModuleFiles
              == (derive [ ]).treeRelative;
            # 4. The shipped image, with no fixture: aws's half must be in it, or the
            # sandbox silently lost `~/.aws/config` and every `aws --profile` with it.
            # Asserted on the UNIT rather than a marker file — that is the thing a
            # deployment would miss. Covers what (1) cannot: (1) proves a derived
            # module lands, this proves the one we actually ship does.
            assert shipped.nixos.config.systemd.services ? "scooter-aws-config";
            assert lib.any (p: (p.pname or p.name or "") == "scooter-aws")
              shipped.nixos.config.environment.systemPackages;
            pkgs.runCommand "contrib-sandbox-check" { } ''
              # 5. The in-pod half. Every entry in the baked list must be a file that
              # EXISTS, UNDER THE VENDORED TREE — the two ways this list fails in the
              # pod and nowhere else:
              #   a path that resolves nowhere is a module the first self-modify
              #   silently drops (the sandbox loses a contrib's tools and nothing
              #   says so);
              #   a path outside the tree is a reference to the FLAKE SOURCE, which
              #   drags the whole repo into the sandbox closure and re-tags every
              #   image when any file in it moves (#614).
              echo "baked re-converge list:"
              ${pkgs.jq}/bin/jq -r '.[]' ${listFile}
              for p in $(${pkgs.jq}/bin/jq -r '.[]' ${listFile}); do
                case "$p" in
                  ${tree}/*) ;;
                  *) echo "FAIL: $p is not under the baked tree ${tree}" >&2; exit 1 ;;
                esac
                test -f "$p" || { echo "FAIL: $p is in the list but is not a file" >&2; exit 1; }
              done
              # Both halves are actually in there (jq over an empty list would pass
              # the loop above vacuously).
              ${pkgs.jq}/bin/jq -e 'map(endswith("/contrib/aws/sandbox.nix")) | any' ${listFile} >/dev/null
              ${pkgs.jq}/bin/jq -e 'map(endswith("/contrib/echo/sandbox.nix")) | any' ${listFile} >/dev/null
              # aws's sandbox half embeds the CLI source from its OWN tree, so the
              # vendored copy needs both ends. This is the one the whole-repo vendoring
              # (#614) bought: a curated subset would have shipped the module without
              # its source.
              test -f ${tree}/contrib/aws/scooter_contrib_aws/cli.py
              touch $out
            '';

          # dev-env-* so CI's existing matrix enumerates it; Linux-only like
          # devEnvTests, since it evaluates a NixOS system.
          contribSandboxChecks = lib.optionalAttrs pkgs.stdenv.isLinux {
            dev-env-contrib-sandbox = contribSandbox;
          };
        in
        {
          legacyPackages.evalPlatform = evalPlatform;

          packages = {
            # The sandbox is the NixOS systemd-PID-1 dev image (the legacy generic
            # pkgs/sandbox-image was retired).
            default = sandboxOsImage.image;

            # `nix build .#options-doc` -> the scooter.* option reference as JSON,
            # rendered FROM the module system (nixosOptionsDoc), so the published reference can
            # never drift from the code. JSON rather than CommonMark on purpose: the docs build
            # splits it into one page PER NAMESPACE (so mkdocs search scores each separately
            # instead of returning one 4k-line document) and feeds the client-side filter table.
            # See docs/gen_options.py.
            # `contribs` is published alongside `scooter`: an integration's deployment
            # options live under `contribs.<name>` now, beside the contrib's own
            # declaration, so a reference of `scooter.*` alone would document the
            # platform and none of the integrations. Rendered from a BARE render, so
            # every contrib's options appear whether or not a deployment configures
            # them. docs/gen_options.py pages these under their contrib's name.
            options-doc =
              (pkgs.nixosOptionsDoc {
                options = {
                  inherit ((mkPlatform { }).options) scooter contribs;
                };
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

            # `nix build .#db-spec` -> the lib/sql artifacts RENDERED from the
            # `scooter.db` module option (#606): the ownership manifest and atlas.hcl's
            # per-database envs. `just db-generate` copies these into lib/sql and
            # `just db-generate-check` fails CI on drift — so "which databases exist" and
            # "who owns which table" have exactly one source. (The database LIST is not a
            # third artifact: owners.toml's top-level sections are it.)
            #
            # Evaluated with an EMPTY scooter config: the in-tree declarations are
            # unconditional, so the artifacts don't depend on a deployment's feature
            # flags. (A contrib declaring tables inside `mkIf cfg.enable` — stage 2 of
            # #606 — is what makes them deployment-shaped; that is the point at which
            # an out-of-tree deployment regenerates its own.)
            # contribs: the tables are a property of the SOURCE TREE, so this
            # renders with what the repo ships, not with bare defaults (#637).
            db-spec =
              let spec = (mkPlatform { contribs = shippedContribs; }).config.scooter.dbSpec; in
              pkgs.runCommand "db-spec" {
                ownersToml = spec.ownersToml;
                atlasHcl = spec.atlasHcl;
                passAsFile = [ "ownersToml" "atlasHcl" ];
              } ''
                mkdir -p $out
                cp "$ownersTomlPath" $out/owners.toml
                cp "$atlasHclPath"   $out/atlas.hcl
              '';

            inherit agentHost ui broker webhooks scheduler;

            # nix build .#contrib-echo / .#contrib-echo-webhooks -> the reference
            # contrib, built once PER TARGET SERVICE so each variant carries only that
            # service's extension surface (a single build would drag the webhooks
            # surface into the broker image).
            contrib-echo = contribsWithExamples.packages.echo.broker;
            contrib-echo-webhooks = contribsWithExamples.packages.echo.webhooks;
            contrib-airtable = contribs.packages.airtable.broker;
            contrib-brave = contribs.packages.brave.broker;
            contrib-datadog = contribs.packages.datadog.broker;
            contrib-duckduckgo = contribs.packages.duckduckgo.broker;
            contrib-github = contribs.packages.github.broker;
            contrib-github-webhooks = contribs.packages.github.webhooks;
            contrib-gitlab = contribs.packages.gitlab.broker;
            contrib-gitlab-webhooks = contribs.packages.gitlab.webhooks;
            contrib-grafana = contribs.packages.grafana.broker;
            contrib-jira = contribs.packages.jira.broker;
            contrib-jira-webhooks = contribs.packages.jira.webhooks;
            contrib-kagi = contribs.packages.kagi.broker;
            contrib-slack = contribs.packages.slack.broker;
            contrib-slack-webhooks = contribs.packages.slack.webhooks;

            # nix build .#contribs-all -> every variant of every contrib, so ONE CI
            # target covers all of them and a new contrib is tested the moment it
            # exists.
            contribs-all = contribsAll;

            conversation-controller = conversationController;
            conversation-router = conversationRouter;
            byoc-controller = byocController;
            warm-store-controller = warmStoreController;
            inherit agent; # the ACP agent (goose), exposed for the agent-host
            inherit marimoMcp; # the isolated marimo MCP server (buildable/inspectable)

            # nix build .#sandbox-os-image  ->  NixOS systemd-PID-1 dev sandbox with the
            # writable local-overlay Nix store ALWAYS ON (the sole sandbox image now).
            sandbox-os-image = builtImages.agent-sandbox-os.package;

            # The broker tools (agent-broker / git-credential-broker),
            # prebuilt; baked into the sandbox-os image via the brokerTools overlay.
            broker-tools = brokerTools.agent-broker;

            # nix build .#broker-image  ->  broker OCI image
            broker-image = builtImages.agent-broker.package;

            # nix build .#db-migrator-image  ->  shared-DB migration Job image
            db-migrator-image = builtImages.agent-db-migrator.package;

            # nix build .#webhooks-image  ->  webhooks OCI image
            webhooks-image = builtImages.agent-webhooks.package;

            # nix build .#scheduler-image  ->  scheduler OCI image
            scheduler-image = builtImages.agent-scheduler.package;

            # nix build .#scooter-schema  ->  generated SQLAlchemy models (runs pytest)
            scooter-schema = scooterSchema;

            # nix build .#scooter-lib / .#scooter-broker-lib / .#scooter-webhooks-lib
            # -> the shared Python libraries (the lib split).
            scooter-lib = scooterLib;
            scooter-broker-lib = scooterBrokerLib;
            scooter-webhooks-lib = scooterWebhooksLib;

            # nix build .#scooter-schema-js  ->  generated Drizzle schema package (tsc)
            scooter-schema-js = scooterSchemaJs;

            # nix build .#remote-agent  ->  the BYO-Claude container app (bin)
            remote-agent = remoteAgent;
            # nix build .#remote-agent-image  ->  BYO-Claude remote agent OCI image (ghcr; unfree claude)
            remote-agent-image = builtImages.remote-agent.package;

            # nix build .#conversation-controller-image  ->  controller OCI image
            conversation-controller-image = builtImages.conversation-controller.package;

            # nix build .#conversation-router-image  ->  router OCI image
            conversation-router-image = builtImages.conversation-router.package;
            # nix build .#byoc-controller-image  ->  BYOC controller OCI image
            byoc-controller-image = builtImages.byoc-controller.package;

            # nix build .#warm-store-controller-image  ->  warm-store controller OCI image
            warm-store-controller-image = builtImages.warm-store-controller.package;

            # nix build .#agent-host-image  ->  agent-host OCI image
            agent-host-image = builtImages.agent-host.package;
            # nix build .#agent-host-image-claude  ->  + the claude CLI (claude-code provider)
            agent-host-image-claude = agentHostImageClaudeBuilder.image;

            # nix build .#ui-image  ->  UI (nginx + static build) OCI image
            ui-image = builtImages.agent-sandbox-ui.package;

            # nix build .#contrib-ui-manifest  ->  the contribs' UI metadata as one
            # JSON document; the UI image serves it at /contrib/manifest.json.
            contrib-ui-manifest = contribs.uiManifest;

            # nix build .#platform-manifests  ->  multi-doc YAML for kubectl apply
            # (e2e/local flavor: bare side-loaded image names).
            platform-manifests = platform.config.kubernetes.resultYAML;

            # The k3d-registry render + the attr->ref push map for the CI/e2e-full flow.
            platform-manifests-k3d = platformK3d.config.kubernetes.resultYAML;
            # The k3d test platform + event backfill enabled — the Tier-2 e2e extracts the
            # rendered agent-event-backfill Job from this YAML (see platformK3dBackfill).
            platform-manifests-k3d-backfill = platformK3dBackfill.config.kubernetes.resultYAML;
            k3d-image-refs = pkgs.writeText "k3d-image-refs.json" (builtins.toJSON k3dPushRefs);

            # ONE attr holding everything .github/scripts/k3d-platform-up.sh needs from
            # this flake, so the script evaluates ONCE instead of three times.
            #
            # The script used to run `nix build .#k3d-image-refs`, then a `nix build`
            # of the eight images, then `nix build .#platform-manifests-k3d`. Each is a
            # separate evaluation, and in CI each one re-evaluates the sandbox-os NixOS
            # system -- the expensive part. The tell is the `stdenv.isLinux is
            # deprecated` warning, which fires from that evaluation: it appeared 55s
            # into image-refs-eval and AGAIN 24.5s into image-manifest-build, the same
            # work twice.
            #
            # That does not reproduce locally, where the ~6.4k derivations are already
            # written and every "evaluation" is a lookup. It is a CI-only cost, so do
            # not trust a local timing to tell you whether this helps.
            #
            # A plain runCommand, NOT symlinkJoin: these are JSON files and YAML, not
            # bin/ trees, and the script reads each path by name anyway. All this needs
            # to do is hold references so one realisation covers the lot.
            k3d-ci-deps = pkgs.runCommand "scooter-k3d-ci-deps" { } ''
              mkdir -p $out
              ln -s ${pkgs.writeText "k3d-image-refs.json" (builtins.toJSON k3dPushRefs)} $out/image-refs.json
              ln -s ${platformK3d.config.kubernetes.resultYAML} $out/platform-manifests-k3d.yaml
              ${lib.concatMapStrings (a: ''
                ln -s ${pubImages.${a}} $out/${a}.json
                ln -s ${pubImages.${a}.copyTo} $out/${a}.copyTo
              '') (builtins.attrNames k3dPushAttrs)}
            '';

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

            # nix build .#ghcr-image-refs  ->  JSON { <camelName> = "ghcr.io/…:<tag>" }
            # Read out of the ghcr render, so it cannot drift from the manifest.
            # Keys stay camelCase: server-config reads them by name.
            ghcr-image-refs = pkgs.writeText "ghcr-image-refs.json" (builtins.toJSON ghcrRefs);
          };

          # Dev shell: everything needed to build, test (Tier 1-3), and drive a
          # local cluster. Defined in ./nix/devshell.nix; `nix develop` or
          # `.envrc` (`use flake`) via direnv both use it.
          devShells.default = import ./nix/devshell.nix { inherit pkgs conversationRouter; };

          checks = {
            inherit agentHost ui;
            # Every contrib variant, each running its tests against the real broker +
            # webhooks registries. The aggregate is what CI builds; the individual
            # attrs stay for bisecting a failure to one variant.
            contribs-all = contribsAll;
            contrib-echo = contribsWithExamples.packages.echo.broker;
            contrib-echo-webhooks = contribsWithExamples.packages.echo.webhooks;
            contrib-airtable = contribs.packages.airtable.broker;
            contrib-brave = contribs.packages.brave.broker;
            contrib-datadog = contribs.packages.datadog.broker;
            contrib-duckduckgo = contribs.packages.duckduckgo.broker;
            contrib-github = contribs.packages.github.broker;
            contrib-github-webhooks = contribs.packages.github.webhooks;
            contrib-gitlab = contribs.packages.gitlab.broker;
            contrib-gitlab-webhooks = contribs.packages.gitlab.webhooks;
            contrib-grafana = contribs.packages.grafana.broker;
            contrib-jira = contribs.packages.jira.broker;
            contrib-jira-webhooks = contribs.packages.jira.webhooks;
            contrib-kagi = contribs.packages.kagi.broker;
            contrib-slack = contribs.packages.slack.broker;
            contrib-slack-webhooks = contribs.packages.slack.webhooks;
            # The shared Python libraries (the lib split).
            inherit scooterLib scooterBrokerLib scooterWebhooksLib;
          } // devEnvTests // contribSandboxChecks;
        };

      flake = {
        # The stub set, per system, for `nix-stubs gen` / `check`:
        #   nix run github:chadac/nix-stubs#check -- --lock modules/sandbox-os/stubs.lock
        # Read with a PLAIN nixpkgs (no stub overlay) — gen records what the real
        # packages evaluate to, which is exactly what the overlay's `prev` sees.
        stubs = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ]
          (system: import ./modules/sandbox-os/stubs.nix {
            pkgs = nixpkgs.legacyPackages.${system};
          });

        # The built-in agent skills as a `filename -> content` attrset, for a host
        # flake to thread into `scooter.agent.skills` (so a custom deploy ships
        # the same skills the default render does). e.g.
        #   scooter.agent.skills = scooter.lib.scooterSkills;
        lib.scooterSkills = scooterSkills;

        # kubenix modules: SandboxTemplate / SandboxWarmPool / Sandbox generators
        # (+ gateway/broker/webhooks Deployments, post-PoC). See modules/.
        kubenixModules.scooter = ./modules;
        # The bare platform module. Image refs come from scooter.images, which
        # carries no `package` here — so every ref floats at :latest.
        kubenixModules.platform = ./modules/platform.nix;
        # The conventional entry point: the platform module plus each image's own
        # scooter.images entry, so a ref is content-pinned out of the box. Tags are
        # x86_64-pinned pure text, keeping this system-independent.
        kubenixModules.default = {
          imports = [ ./modules/platform.nix imagePackageConfig ];
        };
      };
    };
}
