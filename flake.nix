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
      ghcrImages = {
        agentHost = ghcrImageRef "agent-host" pubImages.agent-host-image;
        ui = ghcrImageRef "agent-sandbox-ui" pubImages.ui-image;
        broker = ghcrImageRef "agent-broker" pubImages.broker-image;
        scheduler = ghcrImageRef "agent-scheduler" pubImages.scheduler-image;
        webhooks = ghcrImageRef "agent-webhooks" pubImages.webhooks-image;
        sandboxOs = ghcrImageRef "agent-sandbox-os" pubImages.sandbox-os-image;
        sandboxOsOverlay = ghcrImageRef "agent-sandbox-os-overlay" pubImages.sandbox-os-overlay-image;
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
          # DOWNSTREAM PATCH: sanitize Bedrock tool names to `[a-zA-Z0-9_-]+`. Goose
          # leaks an MCP tool's display name ("<Extension>: <Title Case>") into the
          # Bedrock converse request's toolUse.name on session resume, which Bedrock
          # rejects (ValidationException) — permanently wedging the conversation. The
          # patch sanitizes at the 3 outbound sites (tool def + both toolUse blocks)
          # with a lossless map so the returned name restores for MCP dispatch. Applied
          # via cargoPatches so it slots into the vendored-deps build without touching
          # cargoHash. Remove when an upstream-fixed goose is pinned (the OpenAI side is
          # already fixed in block/goose#10344; the Bedrock side was missed). See
          # pkgs/goose/bedrock-tool-name-sanitize.patch + todo/GOOSE_BEDROCK_PATCH.md.
          agent = pkgs.goose-cli.overrideAttrs (old: {
            cargoPatches = (old.cargoPatches or [ ]) ++ [
              ./pkgs/goose/bedrock-tool-name-sanitize.patch
            ];
          });

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

          agentHost = pkgs.callPackage ./services/agent-host { inherit agent claudeSdkProvider marimoMcp; };

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
          broker = pkgs.callPackage ./services/broker { };

          # Webhooks (Python/FastAPI): spawn agent conversations from
          # GitHub/GitLab/Jira/Slack threads. See services/webhooks/ + docs/WEBHOOKS.md.
          webhooks = pkgs.callPackage ./services/webhooks { };

          # Webhooks OCI image.
          webhooksImage = import ./pkgs/webhooks-image {
            inherit pkgs lib n2c webhooks;
          };

          # Scheduler (Python/FastAPI): fires scheduled tasks on a cron schedule,
          # spawning a fresh conversation per run via the agent-host /agui. See
          # services/scheduler/ + todo/SCHEDULED_TASKS.md.
          scheduler = pkgs.callPackage ./services/scheduler { };

          # Scheduler OCI image.
          schedulerImage = import ./pkgs/scheduler-image {
            inherit pkgs lib n2c scheduler;
          };

          # Broker OCI image.
          brokerImage = import ./pkgs/broker-image {
            inherit pkgs lib n2c broker;
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
          # services). Built from the shared modules/sandbox-os config.
          sandboxOsImage = import ./pkgs/sandbox-os {
            inherit pkgs lib n2c nixStubsLib uvNix;
          };

          # Same image with the read-only-base + writable-upper local-overlay store
          # turned ON (programs.overlayStore). The Tier-2 cluster test runs THIS in a
          # real container — where the lower is the baked store and there's no VM
          # register-nix-paths — to prove the prod topology the nixosTest can't.
          sandboxOsOverlayImage = import ./pkgs/sandbox-os {
            inherit pkgs lib n2c nixStubsLib;
            name = "agent-sandbox-os-overlay";
            extraModules = [ { programs.overlayStore.enable = true; } ];
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
          mkPlatform = agentSandbox: kubenix.evalModules.${system} {
            module = { kubenix, ... }: {
              imports = [ ./modules/platform.nix ];
              kubenix.project = "agent-sandbox";
              kubernetes.version = "1.31";
              inherit agentSandbox;
            };
          };

          # E2E/cluster-test render (`nix build .#platform-manifests`): the DUMMY agent +
          # test providers, and images SIDE-LOADED into k3s so it uses bare local names
          # (registryPrefix "" overrides the module's ghcr default). This is NOT a deploy
          # manifest — it's the config the Tier-2 cluster + Tier-3 e2e suites apply.
          platform = mkPlatform {
            registryPrefix = "";
            agentHostImage = "agent-host:latest";
            sandboxImage = "agent-sandbox-os:latest";
            agent.skills = scooterSkills; # ship the ./skills/*.md set
            fakeAgent = true; # dummy agent for cluster e2e (no model needed)
            broker = {
              enable = true;
              image = "agent-broker:latest";
              testProvider = true; # whoami provider for the credential e2e
            };
            webhooks = {
              enable = true;
              image = "agent-webhooks:latest";
              testWebhook = true; # /webhooks/test for the spawn e2e
            };
          };

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

            inherit agentHost ui broker webhooks scheduler;
            inherit agent; # the ACP agent (goose), exposed for the agent-host
            inherit marimoMcp; # the isolated marimo MCP server (buildable/inspectable)

            # nix build .#sandbox-os-image  ->  NixOS systemd-PID-1 dev sandbox
            sandbox-os-image = sandboxOsImage.image;

            # nix build .#sandbox-os-overlay-image  ->  same, with the local-overlay
            # Nix store enabled. Used by the Tier-2 overlay-store cluster test.
            sandbox-os-overlay-image = sandboxOsOverlayImage.image;

            # The broker tools (agent-broker / git-credential-broker / scooter-aws*),
            # prebuilt; baked into the sandbox-os image via the brokerTools overlay.
            broker-tools = brokerTools.agent-broker;

            # nix build .#broker-image  ->  broker OCI image
            broker-image = brokerImage.image;

            # nix build .#webhooks-image  ->  webhooks OCI image
            webhooks-image = webhooksImage.image;

            # nix build .#scheduler-image  ->  scheduler OCI image
            scheduler-image = schedulerImage.image;

            # nix build .#agent-host-image  ->  agent-host OCI image
            agent-host-image = agentHostImageBuilder.image;
            # nix build .#agent-host-image-claude  ->  + the claude CLI (claude-code provider)
            agent-host-image-claude = agentHostImageClaudeBuilder.image;

            # nix build .#ui-image  ->  UI (nginx + static build) OCI image
            ui-image = uiImage.image;

            # nix build .#platform-manifests  ->  multi-doc YAML for kubectl apply
            # (e2e/local flavor: bare side-loaded image names).
            platform-manifests = platform.config.kubernetes.resultYAML;

            # nix build .#platform-manifests-ghcr  ->  the same manifests with every image
            # pinned to its published ghcr CONTENT TAG (from ghcrImages). This is the
            # reproducible deploy render — no `nix build .#ghcr-image-refs` + manual
            # per-image override needed. The content tags are pure text (contentTag
            # discards the outPath string context), so this render does NOT build any
            # image — it's still just a YAML writeText.
            platform-manifests-ghcr = platformGhcr.config.kubernetes.resultYAML;

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
          devShells.default = import ./nix/devshell.nix { inherit pkgs; };

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
          };
        };
      };
    };
}
