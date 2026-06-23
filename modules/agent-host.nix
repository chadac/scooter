{ config, lib, ... }:

# agent-host Deployment — runs the TypeScript agent-host that hosts one
# `goose acp` process per conversation and bridges ACP<->AG-UI.
#
# Design stage: shape only. Topology note: starts as ONE deployment hosting many
# goose processes (co-located for fast startup). A future per-conversation-pod
# topology is a deployment change, not an interface change.
#
# RBAC: the agent-host's SA needs to create/patch/delete Sandboxes,
# ServiceAccounts (sandbox-{id}), and PVCs in cfg.namespace (it provisions the
# per-conversation resources from ./conversation.nix at runtime).

let
  inherit (lib) mkOption types;
  cfg = config.agentSandbox;
in
{
  config = {
    # ServiceAccount + Role (sandboxes/serviceaccounts/pvcs: create/get/list/
    #   update/delete; agents.x-k8s.io/sandboxes; extensions claims if used) +
    #   RoleBinding.
    #
    # Deployment.agent-host = {
    #   spec.template.spec.containers = [{
    #     name = "agent-host"; image = cfg.agentHostImage;
    #     ports = [{ containerPort = 8080; }];            # AG-UI server
    #     env = [
    #       { name = "NAMESPACE"; value = cfg.namespace; }
    #       { name = "SANDBOX_IMAGE"; value = cfg.sandboxImage; }
    #       # goose model/provider config (keys via secret) ...
    #     ];
    #     # `goose` binary present on PATH (from the agent-host image).
    #   }];
    # };
    #
    # Service (AG-UI :8080) + Ingress (browser-facing) — the AG-UI stream goes
    # straight from here to the browser (NOT through the agent-sandbox router).
  };
}
