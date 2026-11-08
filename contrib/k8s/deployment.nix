# k8s deployment half: agent-broker's in-cluster roles and its impersonated user.
# No `pkgs`: platform.nix may be imported without one.
{ config, lib, ... }:

let
  cfg = config.scooter;
  ccfg = config.contribs.k8s;
  inCluster = lib.filter (c: c.auth ? inCluster) (lib.attrValues ccfg.clusters);
  roles = lib.unique (lib.concatMap (c: c.auth.inCluster.clusterRoles) inCluster);
  impersonated = lib.filter (c: c.impersonate.user != null) inCluster;
  users = lib.unique (map (c: c.impersonate.user) impersonated);

  rbac = "rbac.authorization.k8s.io";
  broker = [{ kind = "ServiceAccount"; name = "agent-broker"; namespace = cfg.namespace; }];
  user = name: [{ kind = "User"; apiGroup = rbac; inherit name; }];
  roleRef = name: { apiGroup = rbac; kind = "ClusterRole"; inherit name; };
  # A Kubernetes-safe name from any username.
  slug = s: lib.toLower (lib.concatStrings (map (ch: if builtins.match "[A-Za-z0-9-]" ch != null then ch else "-")
    (lib.stringToCharacters s)));

  brokerBinding = role: lib.nameValuePair "agent-broker-k8s-${role}" {
    metadata.name = "agent-broker-k8s-${role}";
    roleRef = roleRef role;
    subjects = broker;
  };
  userBindings = c: lib.listToAttrs (map (role:
    let n = "k8s-user-${slug c.impersonate.user}-${role}"; in
    lib.nameValuePair n { metadata.name = n; roleRef = roleRef role; subjects = user c.impersonate.user; })
    c.impersonate.clusterRoles);
  userRoleBindings = c: lib.listToAttrs (lib.concatLists (lib.mapAttrsToList (ns: rs: map (role:
    let n = "k8s-user-${slug c.impersonate.user}-${role}"; in
    lib.nameValuePair "${ns}-${n}" { metadata = { name = n; namespace = ns; }; roleRef = roleRef role; subjects = user c.impersonate.user; })
    rs) c.impersonate.namespaceRoles));
in
{
  config = lib.mkIf (cfg.broker.enable && ccfg.enable) {
    kubernetes.resources = {
      clusterRoleBindings = lib.listToAttrs (map brokerBinding roles)
        // lib.mergeAttrsList (map userBindings impersonated)
        // lib.optionalAttrs (users != [ ]) {
          agent-broker-k8s-impersonate = {
            metadata.name = "agent-broker-k8s-impersonate";
            roleRef = roleRef "agent-broker-k8s-impersonate";
            subjects = broker;
          };
        };
      roleBindings = lib.mergeAttrsList (map userRoleBindings impersonated);
      clusterRoles = lib.optionalAttrs (users != [ ]) {
        agent-broker-k8s-impersonate = {
          metadata.name = "agent-broker-k8s-impersonate";
          rules = [
            { apiGroups = [ "" ]; resources = [ "users" ]; verbs = [ "impersonate" ]; resourceNames = users; }
            # kube.py's audit extras; the API server lowercases keys.
            {
              apiGroups = [ "authentication.k8s.io" ];
              resources = [ "userextras/scooter-conversation" "userextras/scooter-approver" ];
              verbs = [ "impersonate" ];
            }
          ];
        };
      };
    };
  };
}
