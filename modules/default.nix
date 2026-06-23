{ config, lib, ... }:

# kubenix module entry for kubenix-agent-manager.
#
# Design stage: option signatures + resource shapes only (no rendered values
# committed yet). Generates the agent-sandbox CRs and platform Deployments.
#
# Composed of:
#   ./sandbox-template.nix  — SandboxTemplate (generic body) + optional WarmPool
#   ./conversation.nix      — per-conversation cold Sandbox (SA + 2 PVCs)
#   ./agent-host.nix        — the agent-host Deployment (runs goose per convo)
#   ./broker.nix            — (post-PoC) credential broker, lifted from openhands-nix
#   ./webhooks.nix          — (post-PoC) spawn-from-conversation

let
  inherit (lib) mkOption types;
in
{
  imports = [
    ./sandbox-template.nix
    ./conversation.nix
    ./agent-host.nix
  ];

  options.agentSandbox = {
    namespace = mkOption {
      type = types.str;
      default = "agent-sandbox";
      description = "Namespace for the platform + sandboxes.";
    };

    sandboxImage = mkOption {
      type = types.str;
      description = "OCI ref of the generic Nix sandbox image (pkgs/sandbox-image).";
    };

    agentHostImage = mkOption {
      type = types.str;
      description = "OCI ref of the agent-host image.";
    };

    broker.enable = mkOption {
      type = types.bool;
      default = false;
      description = "Deploy the credential broker (post-PoC).";
    };

    webhooks.enable = mkOption {
      type = types.bool;
      default = false;
      description = "Deploy the webhooks spawn-from-conversation service (post-PoC).";
    };
  };
}
