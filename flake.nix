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

          # Generic Nix sandbox image: agent-sandbox runtime contract (:8888) +
          # overlay /nix store + lazy shims + skills. NO agent/host baked in.
          sandboxImage = import ./pkgs/sandbox-image {
            inherit pkgs lib n2c skillsDir;
          };

          # TypeScript UI (assistant-ui + AG-UI runtime). See ui/.
          ui = pkgs.callPackage ./ui { };
        in
        {
          packages = {
            default = sandboxImage.image;

            inherit agentHost ui;
            inherit agent; # the ACP agent (goose), exposed for the agent-host

            # nix build .#sandbox-image  ->  generic OCI sandbox (runtime + Nix)
            sandbox-image = sandboxImage.image;
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
