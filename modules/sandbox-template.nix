{ config, lib, ... }:

# SandboxTemplate for the generic Nix body, plus an optional WarmPool.
#
# Design stage: shapes the agent-sandbox CRs; values filled at implementation.
#
# Two distinct uses of templates:
#   - This generic template + WarmPool  -> FAST GENERIC CAPACITY (no
#     per-conversation identity/PVCs). Used where a throwaway exec env suffices.
#   - Per-conversation cold Sandboxes (./conversation.nix) reference the SAME
#     podTemplate shape but add a unique SA + PVCs, and are NOT warm-pooled.

let
  inherit (lib) mkOption types;
  cfg = config.agentSandbox;
in
{
  options.agentSandbox.warmPool = {
    enable = mkOption { type = types.bool; default = false; };
    replicas = mkOption { type = types.int; default = 0; };
  };

  config = {
    # kubernetes.resources."extensions.agents.x-k8s.io/v1beta1".SandboxTemplate
    #   .agent-sandbox-generic = {
    #     spec.podTemplate.spec = {
    #       containers = [{ name = "sandbox"; image = cfg.sandboxImage;
    #                       ports = [{ containerPort = 8888; }]; }];
    #       # generic: no per-conversation SA here.
    #     };
    #     # NetworkPolicyManagement = "Managed" default-deny is fine for generic;
    #     # the broker-egress allow is added on the per-conversation Sandbox.
    #   };
    #
    # Optional WarmPool over the generic template (lib.mkIf cfg.warmPool.enable):
    #   SandboxWarmPool.agent-sandbox-generic = {
    #     spec = { replicas = cfg.warmPool.replicas;
    #              sandboxTemplateRef.name = "agent-sandbox-generic"; };
    #   };
  };
}
