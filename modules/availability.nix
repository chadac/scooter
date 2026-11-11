{ config, lib, ... }:

let
  inherit (lib) mkOption types;
  cfg = config.scooter.availability;
  spread = name: builtins.elem name cfg.deployments;
in
{
  options.scooter.availability = {
    deployments = mkOption {
      type = types.listOf types.str;
      default = [ "agent-host" "conversation-router" "agent-broker" "agent-scheduler" "agent-webhooks" "ui" ];
      description = ''
        Deployments kept up through voluntary disruptions (a node drain, Karpenter
        consolidation, a node upgrade). Each listed Deployment that renders gets a
        PodDisruptionBudget allowing `maxUnavailable` evicted pods at a time, and
        soft topologySpreadConstraints over `topologyKeys`, so its replicas land on
        different nodes and a single drain can't evict them all at once. Names not
        rendered are ignored. Set to `[ ]` to render neither.

        Only list Deployments that tolerate running several replicas side by side;
        a Recreate Deployment holding an RWO volume gains nothing from this.
      '';
    };
    maxUnavailable = mkOption {
      type = types.either types.ints.positive types.str;
      default = 1;
      example = "50%";
      description = ''
        `maxUnavailable` of each PodDisruptionBudget: how many of a Deployment's pods
        an eviction may take down at once, as a count or a percentage. A count
        rather than `minAvailable`, so a Deployment scaled to one replica (the
        conversation-controller can autoscale agent-host down to one) still drains.
      '';
    };
    topologyKeys = mkOption {
      type = types.listOf types.str;
      default = [ "kubernetes.io/hostname" "topology.kubernetes.io/zone" ];
      description = ''
        Node labels the listed Deployments spread their pods across, each a
        `ScheduleAnyway` topologySpreadConstraint with maxSkew 1. Soft, so a
        single-node or single-zone cluster still schedules every replica.
      '';
    };
  };

  config.kubernetes = {
    api.defaults = [{
      kind = "Deployment";
      default = { config, ... }: {
        spec.template.spec.topologySpreadConstraints = lib.mkIf (spread config.metadata.name)
          (map (key: {
            maxSkew = 1;
            topologyKey = key;
            whenUnsatisfiable = "ScheduleAnyway";
            labelSelector.matchLabels = config.spec.selector.matchLabels;
          }) cfg.topologyKeys);
      };
    }];

    # The per-kind option, so reading deployments does not recurse.
    api.resources.podDisruptionBudgets = lib.mapAttrs (name: dep: {
      metadata = { inherit name; inherit (dep.metadata) namespace; };
      spec = {
        inherit (cfg) maxUnavailable;
        selector.matchLabels = dep.spec.selector.matchLabels;
      };
    }) (lib.filterAttrs (name: _: spread name) config.kubernetes.api.resources.deployments);
  };
}
