{
  description = "Nix-powered agent sandbox platform layered over the Kubernetes agent-sandbox controller";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Pinned nixpkgs the sandbox's lazy tool stubs resolve packages against
    # (the built-in fallback when the pin ConfigMap isn't mounted). Fixed rev =
    # deterministic eval + eval-cache hits. Bump deliberately.
    nixpkgs-pinned.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    nix2container = {
      url = "github:nlewo/nix2container";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    kubenix = {
      url = "github:hall/kubenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs@{ self, nixpkgs, nixpkgs-pinned, flake-parts, nix2container, kubenix }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];

      perSystem = { pkgs, system, lib, ... }:
        let
          n2c = nix2container.packages.${system}.nix2container;

          # The ACP agent the agent-host runs (first target: Goose).
          # Runs OUTSIDE the sandbox. Provider-agnostic later; selected by attr.
          agent = pkgs.goose-cli;

          # agent-host (TypeScript): runs `goose acp` per conversation OUTSIDE the
          # sandbox; ACP<->AG-UI bridge; exec serviced via the agent-sandbox API.
          # See services/agent-host/.
          agentHost = pkgs.callPackage ./services/agent-host { };

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

          # The NixOS dev-environment sandbox image (systemd PID 1, lazy tools,
          # services). Built from the shared modules/sandbox-os config.
          sandboxOsImage = import ./pkgs/sandbox-os {
            inherit pkgs lib;
            nixpkgsPinned = "path:${inputs.nixpkgs-pinned}";
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
          # local cluster. `nix develop`.
          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              # JS toolchain (agent-host + ui + tests)
              nodejs_22
              # cluster tooling — local k8s + control
              kubectl
              kind
              k3d
              kubernetes-helm
              # image plumbing
              skopeo
              # the ACP agent the agent-host spawns
              goose-cli
              # e2e: Nix-wrapped Playwright browsers (the downloaded ones fail
              # on NixOS — missing libglib etc.)
              playwright-driver.browsers
              # misc used by scripts/tests
              jq
              yq-go
              just
            ];
            shellHook = ''
              echo "kubenix-agent-manager dev shell"
              echo "  just            — task runner (test-quick, test, test-cluster, ...)"
              echo "  goose: $(command -v goose >/dev/null && goose --version 2>/dev/null | head -1 || echo absent)"
              export GOOSE_BIN="$(command -v goose || true)"
              # Point Playwright at the Nix browsers + skip its host-req validation.
              export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
              export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
            '';
          };

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
