# k8s deployment half: agent-broker's in-cluster roles, its impersonated user, and the
# sandbox kubeconfig that points kubectl and helm at the forge proxy.
# No `pkgs`: platform.nix may be imported without one.
{ config, lib, ... }:

let
  cfg = config.scooter;
  ccfg = config.contribs.k8s;
  inCluster = lib.filter (c: c.auth ? inCluster) (lib.attrValues ccfg.clusters);
  roles = lib.unique (lib.concatMap (c: c.auth.inCluster.clusterRoles) inCluster);
  impersonated = lib.filter (c: c.impersonate.user != null) inCluster;
  users = lib.unique (map (c: c.impersonate.user) impersonated);

  names = lib.attrNames ccfg.clusters;
  # Each cluster is a forge-proxy host; the token is a placeholder the broker replaces.
  kubeconfig = {
    apiVersion = "v1";
    kind = "Config";
    clusters = map (n: {
      name = n;
      cluster = {
        server = "https://${n}.k8s.scooter";
        # Includes the forge CA.
        certificate-authority = "/etc/ssl/certs/ca-certificates.crt";
      };
    }) names;
    users = [{ name = "scooter"; user.token = "scooter-forge-proxy"; }];
    contexts = map (n: {
      name = n;
      context = { cluster = n; user = "scooter"; namespace = ccfg.clusters.${n}.defaultNamespace; };
    }) names;
  } // lib.optionalAttrs (lib.length names == 1) { current-context = lib.head names; };

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
    # contrib/k8s/sandbox.nix copies it to ~/.kube/config at boot.
    scooter.sandboxPod = lib.mkIf (names != [ ]) {
      extraVolumeMounts = [{ name = "k8s-kubeconfig"; mountPath = "/etc/scooter/k8s"; readOnly = true; }];
      extraVolumes = [{ name = "k8s-kubeconfig"; configMap.name = "agent-k8s-kubeconfig"; }];
    };

    kubernetes.resources = {
      configMaps = lib.optionalAttrs (names != [ ]) {
        agent-k8s-kubeconfig = {
          metadata = { name = "agent-k8s-kubeconfig"; namespace = cfg.namespace; };
          data.kubeconfig = builtins.toJSON kubeconfig;
        };
      };

      clusterRoleBindings = lib.listToAttrs (map brokerBinding roles)
        // lib.optionalAttrs (inCluster != [ ]) {
          agent-broker-k8s-helm-releases = {
            metadata.name = "agent-broker-k8s-helm-releases";
            roleRef = roleRef "agent-broker-k8s-helm-releases";
            subjects = broker;
          };
        }
        // lib.mergeAttrsList (map userBindings impersonated)
        // lib.optionalAttrs (users != [ ]) {
          agent-broker-k8s-impersonate = {
            metadata.name = "agent-broker-k8s-impersonate";
            roleRef = roleRef "agent-broker-k8s-impersonate";
            subjects = broker;
          };
        };
      roleBindings = lib.mergeAttrsList (map userRoleBindings impersonated);
      clusterRoles = lib.optionalAttrs (inCluster != [ ]) {
        # helm list/status. RBAC can't select by type; the forge proxy narrows these to helm.sh/release.v1.
        agent-broker-k8s-helm-releases = {
          metadata.name = "agent-broker-k8s-helm-releases";
          rules = [{ apiGroups = [ "" ]; resources = [ "secrets" ]; verbs = [ "get" "list" ]; }];
        };
      } // lib.optionalAttrs (users != [ ]) {
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
