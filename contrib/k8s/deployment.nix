# k8s deployment half: binds agent-broker to in-cluster ClusterRoles.
# No `pkgs`: platform.nix may be imported without one.
{ config, lib, ... }:

let
  cfg = config.scooter;
  ccfg = config.contribs.k8s;
  roles = lib.unique (lib.concatMap (c: c.auth.inCluster.clusterRoles)
    (lib.filter (c: c.auth ? inCluster) (lib.attrValues ccfg.clusters)));
  binding = role: lib.nameValuePair "agent-broker-k8s-${role}" {
    metadata.name = "agent-broker-k8s-${role}";
    roleRef = { apiGroup = "rbac.authorization.k8s.io"; kind = "ClusterRole"; name = role; };
    subjects = [{ kind = "ServiceAccount"; name = "agent-broker"; namespace = cfg.namespace; }];
  };
in
{
  config = lib.mkIf (cfg.broker.enable && ccfg.enable && roles != [ ]) {
    kubernetes.resources.clusterRoleBindings = lib.listToAttrs (map binding roles);
  };
}
