{
  description = "Nix-powered agent sandbox platform layered over the Kubernetes agent-sandbox controller";

  inputs = {
    # The single nixpkgs both the platform and sandbox build from.
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
    # Lazy package shims (compiled dispatcher)
    nix-stubs = {
      url = "github:chadac/nix-stubs";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # uv patched to work under Nix
    uv-nix = {
      url = "github:chadac/uv-nix/bin";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs@{ self, nixpkgs, flake-parts, nix2container, kubenix, nix-stubs, uv-nix }:
    let
      # The PLATFORM's agent skills
      scooterSkills =
        let dir = ./skills; l = nixpkgs.lib;
        in l.mapAttrs' (name: _: {
          inherit name; # keep the .md filename as the ConfigMap key
          value = builtins.readFile (dir + "/${name}");
        }) (l.filterAttrs (n: t: t == "regular" && l.hasSuffix ".md" n)
          (builtins.readDir dir));

      # name -> packages attr. Must be plain data: the tag pin runs in the
      # top-level scope, and reaching the per-system image tree from here
      # would route through `self` and recurse.
      imageMeta = {
        agent-host.attr = "agent-host-image";
        agent-sandbox-ui.attr = "ui-image";
        agent-broker.attr = "broker-image";
        agent-scheduler.attr = "scheduler-image";
        agent-webhooks.attr = "webhooks-image";
        agent-sandbox-os.attr = "sandbox-os-image";
        agent-db-migrator.attr = "db-migrator-image";
        byoc-controller.attr = "byoc-controller-image";
        conversation-controller.attr = "conversation-controller-image";
        conversation-router.attr = "conversation-router-image";
        warm-store-controller.attr = "warm-store-controller-image";
      };

      # Tags hash the x86_64 image; publish-images runs there.
      pubImages = self.packages.x86_64-linux;
      imagePackageConfig = { lib, config, ... }: {
        config.scooter.images = lib.mapAttrs
          (_: img: { ref.tag = lib.mkForce (config.scooter.imagesContentTag pubImages.${img.attr}); })
          imageMeta;
      };

      # k3d's registry: `.localhost` resolves on host and in-cluster.
      k3dRegistry = "k3d-scooter-reg.localhost:5800/";


    in
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];

      perSystem = { pkgs, system, lib, ... }:
        let
          n2c = nix2container.packages.${system}.nix2container;

          # The ACP agent the agent-host runs (first target: Goose)
          agent = pkgs.goose-cli;

          # agent-host (TypeScript)
          claudeSdkProvider = pkgs.callPackage ./services/claude-sdk-provider { };

          # The isolated marimo MCP server (notebook tools)
          marimoMcp = pkgs.callPackage ./services/marimo-mcp { };

          # The generated @scooter/schema package: Drizzle tables plus guards.
          scooterSchemaJs = pkgs.callPackage ./lib/ts/scooter-schema { };

          agentHost = pkgs.callPackage ./services/agent-host { inherit agent claudeSdkProvider marimoMcp scooterSchemaJs; };

          # Bring-your-own-Claude container app
          remoteAgent = pkgs.callPackage ./services/remote-agent {
            inherit claudeSdkProvider;
            claude-code = pkgs.claude-code;
          };

          # agent-host OCI image.


          # The contrib-free service builds, to break the cycle.
          brokerBase = pkgs.callPackage ./services/broker { inherit scooterSchema scooterLib scooterBrokerLib; };
          webhooksBase = pkgs.callPackage ./services/webhooks { inherit scooterSchema scooterLib scooterWebhooksLib; };

          # Contrib modules
          deploymentModules = [ ./.github/deployment/config.nix ];
          shippedContribs = (import ./.github/deployment/config.nix).contribs;

          contribs = pkgs.callPackage ./contrib {
            inherit deploymentModules;
            broker = brokerBase;
            webhooks = webhooksBase;
            inherit scooterBrokerLib scooterWebhooksLib;
          };

          # The set CI tests: adds the contribs shipping nowhere.
          contribsWithExamples = contribs.withModules [{
            contribs.echo.enable = pkgs.lib.mkForce true;
          }];

          # Keyed <name>-<service>
          contribsAll = pkgs.linkFarm "contribs-all"
            (pkgs.lib.mapAttrsToList (name: path: { inherit name path; })
              contribsWithExamples.all);

          # Credential broker (Python/FastAPI)
          broker = brokerBase.override { contribs = contribs.broker; };

          # Webhooks (Python/FastAPI): spawn agent conversations from GitHub/GitLab/Jira/Slack threads
          webhooks = webhooksBase.override { contribs = contribs.webhooks; };

          # Webhooks OCI image.

          # Generated SQLAlchemy models for the shared databases.
          scooterSchema = pkgs.callPackage ./lib/py/scooter-schema { };

          # Shared Python libraries (the lib split)
          scooterLib = pkgs.callPackage ./lib/py/scooter-lib { };
          scooterBrokerLib = pkgs.callPackage ./lib/py/scooter-broker-lib { inherit scooterLib; };
          scooterWebhooksLib = pkgs.callPackage ./lib/py/scooter-webhooks-lib { inherit scooterLib scooterSchema; };

          # Scheduler (Python/FastAPI)
          scheduler = pkgs.callPackage ./services/scheduler { };

          # Scheduler OCI image.

          # Bring-your-own-Claude remote agent OCI image (ghcr)

          # Conversation CRD controller (Python)
          conversationController = pkgs.callPackage ./services/conversation-controller { };

          # Conversation router (Go)
          conversationRouter = pkgs.callPackage ./services/conversation-router { };
          byocController = pkgs.callPackage ./services/byoc-controller { inherit scooterSchemaJs; };

          # Warm /nix/store PVC pool controller (Python)
          warmStoreController = pkgs.callPackage ./services/warm-store-controller { };

          # Conversation controller OCI image.

          # Conversation router OCI image.

          # Warm-store controller OCI image.

          # Broker OCI image.

          # Shared-DB migration Job image

          # Broker tools (agent-broker / git-credential-broker), prebuilt
          brokerTools = pkgs.callPackage ./pkgs/broker-tools { };

          # Applied HERE, at pkgs construction, not through `nixpkgs.overlays`
          stubOverlay = import ./modules/sandbox-os/stub-overlay.nix {
            lockLib = nix-stubs.lib;
            flakeLock = ./flake.lock;
            nix-stubs = nix-stubs.packages.${system}.nix-stubs;
          };

          # A pkgs with the stubs applied
          sandboxPkgs = import nixpkgs { inherit system; overlays = [ stubOverlay ]; };

          # The uv-nix uv (patched for Nix)
          uvNix = uv-nix.packages.${system}.default;

          # The NixOS dev-environment sandbox image (systemd PID 1
          sandboxOsImage = import ./pkgs/sandbox-os/image.nix {
                inherit deploymentModules;
            inherit lib n2c uvNix;
            pkgs = sandboxPkgs;
            # For the in-pod re-converge
            nixStubs = {
              src = nix-stubs;
              package = nix-stubs.packages.${system}.nix-stubs;
            };
          };

          # TypeScript UI (assistant-ui + AG-UI runtime)
          ui = pkgs.callPackage ./ui { };

          # UI OCI image

          # Render the platform manifests (namespace
          # remote-agent is excluded: it bakes the unfree claude CLI, so its tag
          # would force an allowUnfree check in every pure eval.
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
          # THE VENDED ENTRY POINT
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

          # What the test renders ship
          testContribs = lib.genAttrs
            [ "aws" "jira" "kagi" "duckduckgo" ]
            (_: { enable = true; });

          # E2E/cluster-test render (`nix build .#platform-manifests`)
          mkTestPlatformConfig = import ./.github/deployment/test-platform.nix {
            inherit lib scooterSkills testContribs;
          };
          mkTestPlatformImages = prefix: mkTestPlatform (mkTestPlatformConfig prefix);
          # Side-loaded into k3s, so bare names on :latest
          platform = mkTestPlatform (mkTestPlatformConfig "" // {
            # Side-loaded: bare names on :latest, overriding the x86_64 tag pin.
            images = builtins.mapAttrs (_: _: { ref.tag = lib.mkOverride 40 "latest"; }) builtImages;
          });
          # `nix build .#platform-manifests-k3d`
          platformK3d = mkTestPlatformImages k3dRegistry;

          # `nix build .#platform-manifests-k3d-backfill`
          platformK3dBackfill = mkTestPlatform (lib.recursiveUpdate (mkTestPlatformConfig k3dRegistry) {
            eventBackfill.enable = true;
            conversationController.historyMirror.retainForMigration = true;
          });

          platformGhcr = mkPlatform (import ./.github/deployment/ghcr-platform.nix {
            inherit scooterSkills testContribs;
          });

          # attr -> k3d ref, for the push script
          k3dImageRefs = platformK3d.config.scooter.images;
          # Every image's k3d ref. k3d-platform-up.sh picks which to push --
          # that list is e2e-only and stays in the script.
          k3dPushRefs = lib.mapAttrs' (_: img: lib.nameValuePair img.attr img.ref.fullUrl)
            (lib.filterAttrs (_: img: img.attr != null) k3dImageRefs);

          # The camelCase refs server-config reads, from the ghcr render.
          ghcrImageRefs = platformGhcr.config.scooter.images;
          # Each image names its own camelCase key, or omits itself.
          ghcrRefs = lib.mapAttrs' (_: img: lib.nameValuePair img.refKey img.ref.fullUrl)
            (lib.filterAttrs (_: img: img.refKey != null) ghcrImageRefs);

          # Tier-1-style config-correctness tests for the dev-environment sandbox
          devEnvTests =
            if pkgs.stdenv.isLinux
            then import ./nixos-tests { inherit pkgs lib stubOverlay deploymentModules; }
            else { };

          # The contrib sandbox surface, without building an image
          contribSandbox =
            let
              # What this repo ships first; a fixture layers on top.
              derive = extraModules: import ./contrib/sandbox-modules.nix {
                inherit lib;
                extraModules = deploymentModules ++ extraModules;
              };
              # echo pins `enable = false` (it must never ship)
              withEcho = derive [{ contribs.echo.enable = lib.mkForce true; }];
              # Just the fixture
              echoOnly = lib.subtractLists (derive [ ]).treeRelative withEcho.treeRelative;
              # Through `extraModuleFiles`
              sandboxWithEcho = import ./pkgs/sandbox-os/image.nix {
                inherit deploymentModules;
                inherit lib n2c uvNix;
                pkgs = sandboxPkgs;
                nixStubs = {
                  src = nix-stubs;
                  package = nix-stubs.packages.${system}.nix-stubs;
                };
                extraModuleFiles = echoOnly;
              };
              # Reached through the CONFIG
              tree = lib.head (lib.filter
                (d: lib.hasSuffix "-sandbox-os-src" (toString d))
                sandboxWithEcho.nixos.config.system.extraDependencies);

              # The image as it actually SHIPS
              shipped = import ./pkgs/sandbox-os/image.nix {
                inherit deploymentModules;
                inherit lib n2c uvNix;
                pkgs = sandboxPkgs;
                nixStubs = {
                  src = nix-stubs;
                  package = nix-stubs.packages.${system}.nix-stubs;
                };
              };
              # The baked re-converge list, as the image renders it
              listFile = sandboxWithEcho.nixos.config.environment.etc."scooter/reconverge-modules.json".source;
            in
            # 1
            assert sandboxWithEcho.nixos.config.environment.etc ? "scooter/contrib-echo";
            # 2
            assert echoOnly == [ "contrib/echo/sandbox.nix" ];
            # 3
            assert shipped.nixos.config.programs.scooterModule.extraReconvergeModuleFiles
              == (derive [ ]).treeRelative;
            # 4
            assert shipped.nixos.config.systemd.services ? "scooter-aws-config";
            assert lib.any (p: (p.pname or p.name or "") == "scooter-aws")
              shipped.nixos.config.environment.systemPackages;
            pkgs.runCommand "contrib-sandbox-check" { } ''
              # 5
              echo "baked re-converge list:"
              ${pkgs.jq}/bin/jq -r '.[]' ${listFile}
              for p in $(${pkgs.jq}/bin/jq -r '.[]' ${listFile}); do
                case "$p" in
                  ${tree}/*) ;;
                  *) echo "FAIL: $p is not under the baked tree ${tree}" >&2; exit 1 ;;
                esac
                test -f "$p" || { echo "FAIL: $p is in the list but is not a file" >&2; exit 1; }
              done
              # Both halves are actually in there (jq over an empty
              ${pkgs.jq}/bin/jq -e 'map(endswith("/contrib/aws/sandbox.nix")) | any' ${listFile} >/dev/null
              ${pkgs.jq}/bin/jq -e 'map(endswith("/contrib/echo/sandbox.nix")) | any' ${listFile} >/dev/null
              # aws's sandbox half embeds the CLI source from its OWN
              test -f ${tree}/contrib/aws/scooter_contrib_aws/cli.py
              touch $out
            '';

          # dev-env-* so CI's existing matrix enumerates it; Linux-only like devEnvTests
          contribSandboxChecks = lib.optionalAttrs pkgs.stdenv.isLinux {
            dev-env-contrib-sandbox = contribSandbox;
          };
        in
        {
          legacyPackages.evalPlatform = evalPlatform;
          legacyPackages.imageModules = imageModules;

          packages = {
            # The sandbox is the NixOS systemd-PID-1 dev image (the legacy
            default = sandboxOsImage.image;

            # `nix build .#options-doc` -> the scooter.* option reference as JSON
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

            # nix build .#contrib-echo / .#contrib-echo-webhooks -> the reference contrib
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

            # nix build .#contribs-all -> every variant of every contrib
            contribs-all = contribsAll;

            conversation-controller = conversationController;
            conversation-router = conversationRouter;
            byoc-controller = byocController;
            warm-store-controller = warmStoreController;
            inherit agent; # the ACP agent (goose), exposed for the agent-host
            inherit marimoMcp; # the isolated marimo MCP server (buildable/inspectable)

            # nix build .#sandbox-os-image -> NixOS systemd-PID-1 dev sandbox with the
            sandbox-os-image = builtImages.agent-sandbox-os.package;

            # The broker tools (agent-broker / git-credential-broker)
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

            # nix build .#scooter-lib / .#scooter-broker-lib / .#scooter-webhooks-lib -> the shared
            scooter-lib = scooterLib;
            scooter-broker-lib = scooterBrokerLib;
            scooter-webhooks-lib = scooterWebhooksLib;

            # nix build .#scooter-schema-js  ->  generated Drizzle schema package (tsc)
            scooter-schema-js = scooterSchemaJs;

            # nix build .#remote-agent  ->  the BYO-Claude container app (bin)
            remote-agent = remoteAgent;
            # nix build .#remote-agent-image -> BYO-Claude remote agent OCI image (ghcr;
            # Evaluated alone: the unfree claude CLI keeps it out of the shared tree.
            remote-agent-image =
              (evalPlatform {
                module = import ./pkgs/remote-agent-image/image.nix imageArgs;
              }).config.scooter.images.remote-agent.package;

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
            agent-host-image-claude =
              (evalPlatform {
                module = { config.scooter.images.agent-host.claude.enable = true; };
              }).config.scooter.images.agent-host.package;

            # nix build .#ui-image -> UI (nginx + static build) OCI
            ui-image = builtImages.agent-sandbox-ui.package;

            # nix build .#contrib-ui-manifest -> the contribs' UI metadata as one
            contrib-ui-manifest = contribs.uiManifest;

            # nix build .#platform-manifests -> multi-doc YAML for kubectl apply (e2e/local
            platform-manifests = platform.config.kubernetes.resultYAML;

            # The k3d-registry render + the attr->ref push map for the
            platform-manifests-k3d = platformK3d.config.kubernetes.resultYAML;
            # The k3d test platform + event backfill enabled
            platform-manifests-k3d-backfill = platformK3dBackfill.config.kubernetes.resultYAML;
            k3d-image-refs = pkgs.writeText "k3d-image-refs.json" (builtins.toJSON k3dPushRefs);

            # ONE attr holding everything .github/scripts/k3d-platform-up.sh needs from this flake
            k3d-ci-deps = pkgs.runCommand "scooter-k3d-ci-deps" { } ''
              mkdir -p $out
              ln -s ${pkgs.writeText "k3d-image-refs.json" (builtins.toJSON k3dPushRefs)} $out/image-refs.json
              ln -s ${platformK3d.config.kubernetes.resultYAML} $out/platform-manifests-k3d.yaml
              ${lib.concatMapStrings (a: ''
                ln -s ${pubImages.${a}} $out/${a}.json
                ln -s ${pubImages.${a}.copyTo} $out/${a}.copyTo
              '') (builtins.attrNames k3dPushRefs)}
            '';

            # nix build .#platform-manifests-ghcr -> the same manifests with every image
            platform-manifests-ghcr = platformGhcr.config.kubernetes.resultYAML;

            # `nix build .#example-manifests` -> the YAML the EXAMPLE config renders
            example-manifests =
              (evalPlatform { module = ./examples/kubenix-config.nix; })
                .config.kubernetes.resultYAML;

            # nix build .#ghcr-image-refs -> JSON { <camelName> = "ghcr.io/…:<tag>" }
            ghcr-image-refs = pkgs.writeText "ghcr-image-refs.json" (builtins.toJSON ghcrRefs);
          };

          # Dev shell
          devShells.default = import ./nix/devshell.nix { inherit pkgs conversationRouter; };

          checks = {
            inherit agentHost ui;
            # Every contrib variant
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
        # The stub set, per system, for `nix-stubs gen` / `check`
        stubs = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ]
          (system: import ./modules/sandbox-os/stubs.nix {
            pkgs = nixpkgs.legacyPackages.${system};
          });

        # The built-in agent skills as a `filename -> content` attrset
        lib.scooterSkills = scooterSkills;

        # kubenix modules
        kubenixModules.scooter = ./modules;
        # The bare platform module
        kubenixModules.platform = ./modules/platform.nix;
        # The conventional entry point
        kubenixModules.default = {
          imports = [ ./modules/platform.nix imagePackageConfig ];
        };
      };
    };
}
