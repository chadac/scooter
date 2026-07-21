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
  };

  outputs = inputs@{ self, nixpkgs, flake-parts, nix2container, kubenix, nix-stubs }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];

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
          agentHost = pkgs.callPackage ./services/agent-host { inherit agent; };

          # agent-host OCI image.
          agentHostImageBuilder = import ./pkgs/agent-host-image {
            inherit pkgs lib n2c agentHost agent; # agent (goose) for its own layer
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

          # The NixOS dev-environment sandbox image (systemd PID 1, lazy tools,
          # services). Built from the shared modules/sandbox-os config.
          sandboxOsImage = import ./pkgs/sandbox-os {
            inherit pkgs lib nixStubsLib;
          };

          # Same image with the read-only-base + writable-upper local-overlay store
          # turned ON (programs.overlayStore). The Tier-2 cluster test runs THIS in a
          # real container — where the lower is the baked store and there's no VM
          # register-nix-paths — to prove the prod topology the nixosTest can't.
          sandboxOsOverlayImage = import ./pkgs/sandbox-os {
            inherit pkgs lib nixStubsLib;
            name = "agent-sandbox-os-overlay";
            extraModules = [ { programs.overlayStore.enable = true; } ];
          };

          # TypeScript UI (assistant-ui + AG-UI runtime). See ui/.
          ui = pkgs.callPackage ./ui { };

          # UI OCI image: nginx serving the static build + proxying the agent-host.
          uiImage = import ./pkgs/ui-image {
            inherit pkgs lib n2c ui;
          };

          # Render the platform manifests (namespace, agent-host Deployment +
          # RBAC) with kubenix. `nix build .#platform-manifests` -> a YAML file.
          platform = kubenix.evalModules.${system} {
            module = { kubenix, ... }: {
              imports = [ ./modules/platform.nix ];
              kubenix.project = "agent-sandbox";
              kubernetes.version = "1.31";
              agentSandbox = {
                agentHostImage = "agent-host:latest";
                sandboxImage = "agent-sandbox-os:latest";
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

            inherit agentHost ui broker webhooks;
            inherit agent; # the ACP agent (goose), exposed for the agent-host

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

            # nix build .#agent-host-image  ->  agent-host OCI image
            agent-host-image = agentHostImageBuilder.image;

            # nix build .#ui-image  ->  UI (nginx + static build) OCI image
            ui-image = uiImage.image;

            # nix build .#platform-manifests  ->  multi-doc YAML for kubectl apply
            platform-manifests = platform.config.kubernetes.resultYAML;
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
        # kubenix modules: SandboxTemplate / SandboxWarmPool / Sandbox generators
        # (+ gateway/broker/webhooks Deployments, post-PoC). See modules/.
        kubenixModules.agentSandbox = ./modules;
        # The full platform module (agent-host Deployment + broker + webhooks +
        # RBAC). Import this into a host flake's kubenix eval to deploy the
        # platform. `default` is the conventional entry point.
        kubenixModules.platform = ./modules/platform.nix;
        kubenixModules.default = ./modules/platform.nix;
      };
    };
}
