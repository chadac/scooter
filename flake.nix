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
      # The platform's agent skills.
      scooterSkills =
        let dir = ./skills; l = nixpkgs.lib;
        in l.mapAttrs' (name: _: {
          inherit name; # keep the .md filename as the ConfigMap key
          value = builtins.readFile (dir + "/${name}");
        }) (l.filterAttrs (n: t: t == "regular" && l.hasSuffix ".md" n)
          (builtins.readDir dir));

      # Scooter's own inputs, which scooter.config builds from.
      inputsModule = { scooter.config.inputs = { inherit nixpkgs nix2container nix-stubs uv-nix; }; };
      platformModule = { imports = [ ./modules/platform.nix inputsModule ]; };

      # The platform eval, which owns every package and image.
      evalPlatformWith = { system, buildSystem ? "x86_64-linux", modules }: kubenix.evalModules.${system} {
        module = { kubenix, ... }: {
          imports = [ platformModule { scooter.config.buildSystem = buildSystem; } ] ++ modules;
          kubenix.project = "agent-sandbox";
          kubernetes.version = "1.31";
        };
      };

      # k3d's registry: `.localhost` resolves on host and in-cluster.
      k3dRegistry = "k3d-scooter-reg.localhost:5800/";
    in
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];

      perSystem = { system, lib, ... }:
        let
          # Packages build for the system they're listed under.
          evalPlatform = { module }: evalPlatformWith { inherit system; buildSystem = system; modules = [ module ]; };

          # `contribs` is at the module root, not under `scooter`.
          mkPlatformWith = extraModules: full: evalPlatformWith {
            inherit system;
            buildSystem = system;
            modules = extraModules ++ [ {
              contribs = full.contribs or { };
              scooter = builtins.removeAttrs full [ "contribs" ];
            }];
          };
          mkPlatform = mkPlatformWith [ ];
          mkTestPlatform = mkPlatformWith [ ./modules/testing.nix ];

          # This repo's own build: the shipped contribs.
          build = (mkPlatform { }).config.scooter;
          p = build.packages;
          inherit (build.config) contribs;
          pkgs = build.config.buildPkgs;
          builtImages = build.images;
          shippedContribs = (import ./.github/deployment/config.nix).contribs;

          # The set CI tests: adds the contribs shipping nowhere.
          contribsWithExamples = contribs.withModules [{
            contribs.echo.enable = lib.mkForce true;
          }];

          # Keyed <name>-<service>
          contribsAll = pkgs.linkFarm "contribs-all"
            (lib.mapAttrsToList (name: path: { inherit name path; })
              contribsWithExamples.all);

          # The sandbox image, with the shipped build's inputs unless overridden.
          mkSandboxOs = args: import ./pkgs/sandbox-os/image.nix ({
            inherit lib;
            inherit (build.config) n2c nixStubs deploymentModules;
            pkgs = build.config.sandboxPkgs;
          } // args);

          # What the test renders ship
          testContribs = lib.genAttrs
            [ "aws" "jira" "kagi" "duckduckgo" ]
            (_: { enable = true; });

          # E2E/cluster-test render (`nix build .#platform-manifests`)
          mkTestPlatformConfig = import ./.github/deployment/test-platform.nix {
            inherit lib scooterSkills testContribs;
          };
          # Side-loaded into k3s, so bare names on :latest
          platform = mkTestPlatform (mkTestPlatformConfig "" // {
            images = builtins.mapAttrs (_: _: { ref.tag = lib.mkOverride 40 "latest"; }) builtImages;
          });
          # `nix build .#platform-manifests-k3d`
          platformK3d = mkTestPlatform (lib.recursiveUpdate (mkTestPlatformConfig k3dRegistry) {
            # The warm overlay pool, so e2e-full runs every sandbox through /reserve.
            # One warm volume at a time, since each warm Job is a full sandbox boot.
            warmStore = {
              enable = true;
              minWarm = 1;
              maxWarm = 1;
              maxWarmJobs = 1;
              sizing.policy = "fixed";
            };
          });

          # `nix build .#platform-manifests-k3d-backfill`
          platformK3dBackfill = mkTestPlatform (lib.recursiveUpdate (mkTestPlatformConfig k3dRegistry) {
            eventBackfill.enable = true;
            conversationController.historyMirror.retainForMigration = true;
          });

          platformGhcr = mkPlatform (import ./.github/deployment/ghcr-platform.nix {
            inherit scooterSkills testContribs;
          });

          # The k3d render's pushable images, with their packages.
          k3dImages = lib.filterAttrs (_: img: img.attr != null) platformK3d.config.scooter.images;
          # Every image's k3d ref, from which k3d-platform-up.sh picks what to push.
          k3dPushRefs = lib.mapAttrs' (_: img: lib.nameValuePair img.attr img.ref.fullUrl) k3dImages;

          # The camelCase refs server-config reads, from the ghcr render.
          ghcrImageRefs = platformGhcr.config.scooter.images;
          # Each image names its own camelCase key, or omits itself.
          ghcrRefs = lib.mapAttrs' (_: img: lib.nameValuePair img.refKey img.ref.fullUrl)
            (lib.filterAttrs (_: img: img.refKey != null) ghcrImageRefs);

          # Tier-1-style config-correctness tests for the dev-environment sandbox
          devEnvTests =
            if pkgs.stdenv.isLinux
            then import ./nixos-tests {
              inherit pkgs lib;
              inherit (build.config) stubOverlay deploymentModules;
              byocController = p.scooter-byoc-controller;
              agentHost = p.scooter-agent-host;
              broker = p.scooter-broker;
            }
            else { };

          # The contrib sandbox surface, without building an image
          contribSandbox =
            let
              # What this repo ships first; a fixture layers on top.
              derive = extraModules: import ./contrib/sandbox-modules.nix {
                inherit lib;
                extraModules = build.config.deploymentModules ++ extraModules;
              };
              # echo pins `enable = false` (it must never ship)
              withEcho = derive [{ contribs.echo.enable = lib.mkForce true; }];
              # Just the fixture
              echoOnly = lib.subtractLists (derive [ ]).treeRelative withEcho.treeRelative;
              # Through `extraModuleFiles`
              sandboxWithEcho = mkSandboxOs { extraModuleFiles = echoOnly; };
              # The vendored source tree, reached through the config.
              tree = lib.head (lib.filter
                (d: lib.hasSuffix "-sandbox-os-src" (toString d))
                sandboxWithEcho.nixos.config.system.extraDependencies);

              # The image as it ships.
              shipped = mkSandboxOs { };
              # The baked re-converge list, as the image renders it
              listFile = sandboxWithEcho.nixos.config.environment.etc."scooter/reconverge-modules.json".source;
              shippedListFile = shipped.nixos.config.environment.etc."scooter/reconverge-modules.json".source;

              # echo enabled as a contrib (not just its module file), so its skill
              # DIRECTORY goes through modules/skills like a shipped one would.
              withEchoSkills = mkSandboxOs {
                deploymentModules = build.config.deploymentModules ++ [{ contribs.echo.enable = lib.mkForce true; }];
              };
              skillCfg = withEchoSkills.nixos.config;
              skillSrc = skillCfg.scooter.skillDirs.echo-skill;
              skillTree = lib.head (lib.filter
                (d: lib.hasSuffix "-sandbox-os-src" (toString d))
                skillCfg.system.extraDependencies);
              notebookStart = shipped.nixos.config.systemd.services.webservice-notebook.serviceConfig.ExecStart;
              notebookPort = shipped.nixos.config.webServices.notebook.port;
              marimoCfg = shipped.nixos.config.webServices.marimo;
              marimoStart = shipped.nixos.config.systemd.services.webservice-marimo.serviceConfig.ExecStart;
              notebookCfg = shipped.nixos.config.webServices.notebook;
            in
            assert sandboxWithEcho.nixos.config.environment.etc ? "scooter/contrib-echo";
            assert echoOnly == [ "contrib/echo/sandbox.nix" ];
            assert shipped.nixos.config.programs.scooterModule.extraReconvergeModuleFiles
              == (derive [ ]).treeRelative ++ [ "skill-dirs/module.nix" ];
            # marimo ships as a contrib: its service, and marimo-pair's directory for the agent's shell.
            assert builtins.elem "contrib/marimo/sandbox.nix" (derive [ ]).treeRelative;
            assert shipped.nixos.config.webServices.marimo.enable;
            # marimo's settings are on the workspace PVC, beside the agent's own ~/.config.
            assert marimoCfg.environment.XDG_CONFIG_HOME == "/workspace/.config";
            # Its rules are printed whenever the agent starts or checks it (scooter-service).
            assert lib.hasInfix "ctx.packages.add()" notebookCfg.hint;
            assert shipped.nixos.config.environment.etc ? "scooter/skills/marimo-pair";
            # "marimo + chat" ships with it, served at root so its ../marimo/ resolves on either base path.
            assert shipped.nixos.config.webServices.notebook.enable;
            assert shipped.nixos.config.webServices.notebook.stripBasePath;
            # "marimo + chat" is the only marimo the user sees: the server is unlisted, starts
            # with the page and stops or restarts with it.
            assert notebookCfg.displayName == "Notebook" && notebookCfg.visibleInMenu && !marimoCfg.visibleInMenu;
            assert builtins.elem "webservice-marimo.service" shipped.nixos.config.systemd.services.webservice-notebook.wants;
            assert builtins.elem "webservice-notebook.service" shipped.nixos.config.systemd.services.webservice-marimo.partOf;
            assert shipped.nixos.config.systemd.services ? "scooter-aws-config";
            assert skillCfg.environment.etc ? "scooter/skills/echo-skill";
            assert builtins.elem "skill-dirs/module.nix"
              skillCfg.programs.scooterModule.extraReconvergeModuleFiles;
            assert lib.any (p: (p.pname or p.name or "") == "scooter-aws")
              shipped.nixos.config.environment.systemPackages;
            pkgs.runCommand "contrib-sandbox-check" { } ''
              echo "baked re-converge list:"
              ${pkgs.jq}/bin/jq -r '.[]' ${listFile}
              for p in $(${pkgs.jq}/bin/jq -r '.[]' ${listFile}); do
                case "$p" in
                  ${tree}/*) ;;
                  *) echo "FAIL: $p is not under the baked tree ${tree}" >&2; exit 1 ;;
                esac
                test -f "$p" || { echo "FAIL: $p is in the list but is not a file" >&2; exit 1; }
              done
              # marimo-pair's scripts are baked into the tree the in-pod re-converge reads.
              shippedTree=$(dirname "$(dirname "$(${pkgs.jq}/bin/jq -r 'map(select(endswith("/skill-dirs/module.nix")))[0]' ${shippedListFile})")")
              test -f "$shippedTree/skill-dirs/marimo-pair/scripts/execute-code.sh"
              # Both halves are in the baked list.
              ${pkgs.jq}/bin/jq -e 'map(endswith("/contrib/aws/sandbox.nix")) | any' ${listFile} >/dev/null
              ${pkgs.jq}/bin/jq -e 'map(endswith("/contrib/echo/sandbox.nix")) | any' ${listFile} >/dev/null
              # aws's sandbox half embeds the CLI source from its own tree.
              test -f ${tree}/contrib/aws/scooter_contrib_aws/cli.py

              # A skill directory is installed whole, and baked into the tree with the
              # module the in-pod re-converge reads instead of re-resolving it.
              test -x ${skillSrc}/scripts/hello.sh
              case "${skillSrc}" in */*-skill-echo-skill) ;; *) echo "FAIL: ${skillSrc} is not named skill-echo-skill" >&2; exit 1 ;; esac
              diff -r ${skillSrc} ${skillTree}/skill-dirs/echo-skill
              grep -F 'builtins.path { path = ./echo-skill; name = "skill-echo-skill"; }' \
                ${skillTree}/skill-dirs/module.nix

              # The "marimo + chat" page, from its real ExecStart: the chat pane is the
              # conversation's /chat/<id> on the app's origin, and the page is served static.
              export RUNTIME_DIRECTORY=$TMPDIR/nb CONVERSATION_ID=5a515e73-860b-49ba-bc3f-6ff8d5fda5ff
              export CONVERSATION_URL="https://scooter.example.com/?thread=$CONVERSATION_ID&x=1"
              mkdir -p $RUNTIME_DIRECTORY && echo SECRET=1 > $RUNTIME_DIRECTORY/conv.env
              ${notebookStart} &
              for _ in $(seq 50); do ${pkgs.curl}/bin/curl -sf -o $TMPDIR/page.html http://127.0.0.1:${toString notebookPort}/ && break; sleep 0.1; done
              grep -F 'const CHAT_URL = "https://scooter.example.com/chat/5a515e73-860b-49ba-bc3f-6ff8d5fda5ff";' $TMPDIR/page.html
              grep -F 'href="https://scooter.example.com/?thread=5a515e73-860b-49ba-bc3f-6ff8d5fda5ff&x=1"' $TMPDIR/page.html
              grep -F 'new URL("../marimo/", location.href)' $TMPDIR/page.html
              if grep -F '@CHAT_URL@' $TMPDIR/page.html; then echo 'FAIL: placeholder left in the page' >&2; exit 1; fi
              # Only the page: conv.env, beside it in the runtime dir, is not served.
              test "$(${pkgs.curl}/bin/curl --path-as-is -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${toString notebookPort}/../conv.env)" != 200
              kill %1

              # marimo opens notebooks computed: its start seeds runtime.auto_instantiate, but
              # only while marimo has no settings (it leaves an empty file), never over the user's.
              seed=$(grep -o '/nix/store/[^ ]*-marimo-seed-settings' ${marimoStart})
              export HOME=$TMPDIR/home XDG_CONFIG_HOME=$TMPDIR/xdg
              mkdir -p $HOME && cd $HOME
              $seed && grep -Fx 'auto_instantiate = true' $XDG_CONFIG_HOME/marimo/marimo.toml
              : > $XDG_CONFIG_HOME/marimo/marimo.toml && $seed && grep -Fx 'auto_instantiate = true' $XDG_CONFIG_HOME/marimo/marimo.toml
              printf '[runtime]\nauto_instantiate = false\n' > $XDG_CONFIG_HOME/marimo/marimo.toml && $seed
              grep -Fx 'auto_instantiate = false' $XDG_CONFIG_HOME/marimo/marimo.toml
              rm $XDG_CONFIG_HOME/marimo/marimo.toml && echo '[display]' > $HOME/.marimo.toml && $seed
              test ! -e $XDG_CONFIG_HOME/marimo/marimo.toml
              touch $out
            '';

          # dev-env-* so CI's existing matrix enumerates it; Linux-only like devEnvTests
          contribSandboxChecks = lib.optionalAttrs pkgs.stdenv.isLinux {
            dev-env-contrib-sandbox = contribSandbox;
          };
        in
        {
          # Deprecated alias of `lib.evalPlatform`; kept for existing deploys.
          legacyPackages.evalPlatform = { module }: evalPlatformWith { inherit system; modules = [ module ]; };
          # Deprecated: platform.nix declares every image itself now.
          legacyPackages.imageModules = [ ];
          # Package a Python system task: see nix/scooter-task.nix.
          legacyPackages.mkScooterTask = build.config.mkScooterTask;

          packages = {
            # The NixOS systemd-PID-1 sandbox image.
            default = builtImages.agent-sandbox-os.package;

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

            # `nix build .#db-spec` -> the artifacts rendered from the scooter.db spec:
            # owners.toml + atlas.hcl for lib/sql, and contrib/<name>/sql/{owners.toml,atlas.hcl}
            # (at those repo-relative paths) for each contrib database.
            db-spec =
              let spec = (mkPlatform { contribs = shippedContribs; }).config.scooter.dbSpec; in
              pkgs.runCommand "db-spec" {
                ownersToml = spec.ownersToml;
                atlasHcl = spec.atlasHcl;
                passAsFile = [ "ownersToml" "atlasHcl" ];
              } (''
                mkdir -p $out
                cp "$ownersTomlPath" $out/owners.toml
                cp "$atlasHclPath"   $out/atlas.hcl
              '' + pkgs.lib.concatStrings (pkgs.lib.mapAttrsToList (path: text: ''
                install -D -m 644 ${pkgs.writeText "db-spec-file" text} $out/${path}
              '') spec.contribFiles));

            agentHost = p.scooter-agent-host;
            ui = p.scooter-ui;
            broker = p.scooter-broker;
            webhooks = p.scooter-webhooks;
            scheduler = p.scooter-scheduler;

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
            contrib-google = contribs.packages.google.broker;
            contrib-gitlab-webhooks = contribs.packages.gitlab.webhooks;
            contrib-grafana = contribs.packages.grafana.broker;
            contrib-jira = contribs.packages.jira.broker;
            contrib-jira-webhooks = contribs.packages.jira.webhooks;
            contrib-kagi = contribs.packages.kagi.broker;
            contrib-slack = contribs.packages.slack.broker;
            contrib-slack-webhooks = contribs.packages.slack.webhooks;
            # files' broker half is the annotation store; its build carries the whole
            # suite, the sandbox viewer's stdlib tests included, as check inputs.
            contrib-files = contribs.packages.files.broker;
            contrib-personalization = contribs.packages.personalization.broker;
            contrib-shares = contribs.packages.shares.broker;
            contrib-ssh = contribs.packages.ssh.broker;

            # nix build .#contribs-all -> every variant of every contrib
            contribs-all = contribsAll;

            conversation-controller = p.scooter-conversation-controller;
            conversation-router = p.scooter-conversation-router;
            byoc-controller = p.scooter-byoc-controller;
            # contrib/code-server's pieces (stubs in modules/sandbox-os/stubs.nix), built in CI
            # because nix-stubs check only compares their .drv paths.
            inherit (p) scooter-vscode-ahp;
            code-server-bin = p.scooter-code-server-bin;
            warm-store-controller = p.scooter-warm-store-controller;
            agent = p.scooter-agent; # the ACP agent (goose)

            # nix build .#sandbox-os-image -> the NixOS systemd-PID-1 dev sandbox image.
            sandbox-os-image = builtImages.agent-sandbox-os.package;

            # The broker tools (agent-broker)
            broker-tools = p.scooter-broker-tools;

            # nix build .#forge-shim  ->  the sandbox's local forge proxy shim (runs go test)
            forge-shim = p.scooter-forge-shim;
            # One warm-store benchmark round, for the `bench` CI job.
            bench-warm-store = p.scooter-bench-warm-store;

            # nix build .#broker-image  ->  broker OCI image
            broker-image = builtImages.agent-broker.package;

            # nix build .#db-migrator-image  ->  shared-DB migration Job image
            db-migrator-image = builtImages.agent-db-migrator.package;

            # nix build .#webhooks-image  ->  webhooks OCI image
            webhooks-image = builtImages.agent-webhooks.package;

            # nix build .#scheduler-image  ->  scheduler OCI image
            scheduler-image = builtImages.agent-scheduler.package;

            # nix build .#scooter-schema  ->  generated SQLAlchemy models (runs pytest)
            inherit (p) scooter-schema;

            # nix build .#scooter-lib / .#scooter-broker-lib / .#scooter-webhooks-lib -> the shared Python libraries.
            inherit (p) scooter-lib scooter-broker-lib scooter-webhooks-lib;

            # nix build .#scooter-task -> the system-task runtime; nix run .#scooter-prompt -- --help
            inherit (p) scooter-task scooter-prompt;

            # nix build .#scooter-schema-js  ->  generated Drizzle schema package (tsc)
            # nix build .#scooter-svcauth-js  ->  shared ServiceAccount token auth (tsc)
            inherit (p) scooter-schema-js scooter-svcauth-js;

            # nix build .#remote-agent  ->  the BYO-Claude container app (bin)
            remote-agent = p.scooter-remote-agent;
            remote-agent-echo = p.scooter-remote-agent-echo;
            # nix build .#remote-agent-image -> the BYO-Claude remote agent OCI image,
            # outside scooter.images because of its unfree claude CLI.
            remote-agent-image = import ./services/remote-agent/image.nix {
              inherit pkgs;
              inherit (build.config) n2c imageLayers;
              remoteAgent = p.scooter-remote-agent;
            };

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

            # nix build .#contrib-ui-manifest -> the contribs' UI metadata as one manifest.
            contrib-ui-manifest = contribs.uiManifest;

            # nix build .#platform-manifests -> multi-doc YAML for kubectl apply on the e2e/local cluster.
            platform-manifests = platform.config.kubernetes.resultYAML;

            # The k3d-registry render and the attr->ref push map.
            platform-manifests-k3d = platformK3d.config.kubernetes.resultYAML;
            # The k3d test platform + event backfill enabled
            platform-manifests-k3d-backfill = platformK3dBackfill.config.kubernetes.resultYAML;
            k3d-image-refs = pkgs.writeText "k3d-image-refs.json" (builtins.toJSON k3dPushRefs);

            # One attr holding everything .github/scripts/k3d-platform-up.sh needs from this flake.
            k3d-ci-deps = pkgs.runCommand "scooter-k3d-ci-deps" { } ''
              mkdir -p $out
              ln -s ${pkgs.writeText "k3d-image-refs.json" (builtins.toJSON k3dPushRefs)} $out/image-refs.json
              ln -s ${platformK3d.config.kubernetes.resultYAML} $out/platform-manifests-k3d.yaml
              ${lib.concatMapStrings (img: ''
                ln -s ${img.package} $out/${img.attr}.json
                ln -s ${img.package.copyTo} $out/${img.attr}.copyTo
              '') (builtins.attrValues k3dImages)}
            '';

            # nix build .#platform-manifests-ghcr -> the same manifests with every image on its ghcr ref.
            platform-manifests-ghcr = platformGhcr.config.kubernetes.resultYAML;

            # `nix build .#example-manifests` -> the YAML the example config renders.
            example-manifests =
              (evalPlatform { module = ./examples/kubenix-config.nix; })
                .config.kubernetes.resultYAML;

            # nix build .#ghcr-image-refs -> JSON { <camelName> = "ghcr.io/…:<tag>" }
            ghcr-image-refs = pkgs.writeText "ghcr-image-refs.json" (builtins.toJSON ghcrRefs);
          };

          # Dev shell
          devShells.default = import ./nix/devshell.nix {
            inherit pkgs;
            conversationRouter = p.scooter-conversation-router;
          };

          checks = {
            agentHost = p.scooter-agent-host;
            ui = p.scooter-ui;
            # Who may frame which UI page, against the rendered nginx config.
            ui-nginx = import ./services/ui/image/check.nix { inherit pkgs; };
            # Every contrib variant
            contribs-all = contribsAll;
            contrib-aws-rules = import ./contrib/aws/tests/rules-eval.nix { inherit pkgs lib; };
            contrib-echo = contribsWithExamples.packages.echo.broker;
            contrib-echo-webhooks = contribsWithExamples.packages.echo.webhooks;
            contrib-airtable = contribs.packages.airtable.broker;
            contrib-brave = contribs.packages.brave.broker;
            contrib-datadog = contribs.packages.datadog.broker;
            contrib-duckduckgo = contribs.packages.duckduckgo.broker;
            contrib-github = contribs.packages.github.broker;
            contrib-github-webhooks = contribs.packages.github.webhooks;
            contrib-gitlab = contribs.packages.gitlab.broker;
            contrib-google = contribs.packages.google.broker;
            contrib-gitlab-webhooks = contribs.packages.gitlab.webhooks;
            contrib-grafana = contribs.packages.grafana.broker;
            contrib-jira = contribs.packages.jira.broker;
            contrib-jira-webhooks = contribs.packages.jira.webhooks;
            contrib-kagi = contribs.packages.kagi.broker;
            contrib-slack = contribs.packages.slack.broker;
            contrib-slack-webhooks = contribs.packages.slack.webhooks;
            contrib-files = contribs.packages.files.broker;
            contrib-personalization = contribs.packages.personalization.broker;
            contrib-shares = contribs.packages.shares.broker;
            contrib-ssh = contribs.packages.ssh.broker;
            # Every shipped handler and provider imports in its service's runtime env.
            webhooks-entrypoints = import ./nix/check-entrypoints.nix {
              inherit pkgs; name = "webhooks-entrypoints"; package = p.scooter-webhooks; bin = "agent-webhooks"; group = "scooter_webhooks.handlers";
            };
            broker-entrypoints = import ./nix/check-entrypoints.nix {
              inherit pkgs; name = "broker-entrypoints"; package = p.scooter-broker; bin = "agent-broker"; group = "agent_broker.providers";
            };
            # The shared Python libraries.
            scooterLib = p.scooter-lib;
            scooterBrokerLib = p.scooter-broker-lib;
            scooterWebhooksLib = p.scooter-webhooks-lib;
            scooterTask = p.scooter-task;
            scooterPrompt = p.scooter-prompt;
            scooter-prompt-tests = p.scooter-prompt.tests;
          } // devEnvTests // contribSandboxChecks
          # The deploy's migrator against a scratch Postgres, without and with contribs.
          // import ./nix/check-db-migrations.nix {
            inherit pkgs lib evalPlatform;
            contribRegistry = contribsWithExamples;
          };
        };

      flake = {
        # The stub set, per system, for `nix-stubs gen` / `check`
        stubs = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ]
          (system: import ./modules/sandbox-os/stubs.nix {
            pkgs = nixpkgs.legacyPackages.${system};
            uvNixSrc = uv-nix.outPath;
          });

        # The built-in agent skills as a `filename -> content` attrset
        lib.scooterSkills = scooterSkills;

        # The entry point for a deployment: render the platform from your own config module.
        #   (scooter.lib.evalPlatform { system = "aarch64-darwin"; module = ./scooter.nix; })
        #     .config.kubernetes.result
        # `system` renders the manifests; `buildSystem` (x86_64-linux) builds the images.
        lib.evalPlatform = { system, buildSystem ? "x86_64-linux", module }:
          evalPlatformWith { inherit system buildSystem; modules = [ module ]; };

        # kubenix modules
        kubenixModules.scooter = ./modules;
        # The platform module, with the inputs its packages build from
        kubenixModules.platform = platformModule;
        # The conventional entry point
        kubenixModules.default = platformModule;
      };
    };
}
