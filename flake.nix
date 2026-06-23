{
  description = "Nix-powered agent sandbox platform layered over the Kubernetes agent-sandbox controller";

  inputs = {
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
  };

  outputs = inputs@{ self, nixpkgs, flake-parts, nix2container, kubenix }:
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
          # See agent-host/.
          agentHost = pkgs.callPackage ./agent-host { };

          # Layered agent skills (markdown; frontmatter + body). See skills/.
          skillsDir = ./skills;

          # Generic Nix sandbox image: plain Nix env + overlay /nix store +
          # skills. No in-pod server (exec via K8s API). NO agent baked in.
          sandboxImage = import ./pkgs/sandbox-image {
            inherit pkgs lib n2c skillsDir;
          };

          # TypeScript UI (assistant-ui + AG-UI runtime). See ui/.
          ui = pkgs.callPackage ./ui { };

          # Render the platform manifests (namespace, agent-host Deployment +
          # RBAC) with kubenix. `nix build .#platform-manifests` -> a YAML file.
          platform = kubenix.evalModules.${system} {
            module = { kubenix, ... }: {
              imports = [ ./modules/platform.nix ];
              kubenix.project = "agent-sandbox";
              kubernetes.version = "1.31";
              agentSandbox = {
                agentHostImage = "agent-host:latest";
                sandboxImage = "agent-sandbox-nix:latest";
              };
            };
          };
        in
        {
          packages = {
            default = sandboxImage.image;

            inherit agentHost ui;
            inherit agent; # the ACP agent (goose), exposed for the agent-host

            # nix build .#sandbox-image  ->  generic OCI sandbox (runtime + Nix)
            sandbox-image = sandboxImage.image;

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

          # Expose the image builder so consumers can customize
          # (extra skills, extra packages).
          legacyPackages = {
            inherit sandboxImage;
          };

          checks = {
            inherit agentHost ui;
          };
        };

      flake = {
        # kubenix modules: SandboxTemplate / SandboxWarmPool / Sandbox generators
        # (+ gateway/broker/webhooks Deployments, post-PoC). See modules/.
        kubenixModules.agentSandbox = ./modules;
      };
    };
}
