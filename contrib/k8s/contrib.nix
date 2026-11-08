# k8s: cluster tools via the broker; people approve every write.
{ lib, ... }:

let
  inherit (lib) mkOption types;
  clib = import ../lib.nix { inherit lib; };

  checkName = name:
    lib.throwIf (builtins.match "[a-z0-9]([a-z0-9-]*[a-z0-9])?" name == null)
      "contribs.k8s.clusters.${name}: a cluster name is lowercase letters, digits and dashes"
      name;

  # The env var a cluster's kubeconfig Secret is mounted as.
  # The impersonated user, after checks that need the whole cluster.
  impersonateUser = name: c:
    let
      i = c.impersonate;
      where = "contribs.k8s.clusters.${name}.impersonate";
    in
    lib.throwIf (i.user != null && lib.hasPrefix "system:" i.user)
      "${where}.user: system: names belong to Kubernetes"
    (lib.throwIf (i.user == null && (i.clusterRoles != [ ] || i.namespaceRoles != { }))
      "${where}: roles need a user to bind them to"
    (lib.throwIf (!(c.auth ? inCluster) && (i.clusterRoles != [ ] || i.namespaceRoles != { }))
      "${where}: roles are bound only on inCluster clusters; bind a kubeconfig cluster's user there"
      i.user));

  kubeconfigEnv = name: "K8S_KUBECONFIG_${lib.toUpper (lib.replaceStrings [ "-" ] [ "_" ] (checkName name))}";

  authType = types.attrTag {
    inCluster = mkOption {
      description = "The cluster Scooter runs in, as the broker's own ServiceAccount.";
      type = types.submodule {
        options.clusterRoles = mkOption {
          type = types.listOf types.str;
          default = [ "view" ];
          example = [ "view" "edit" ];
          description = ''
            ClusterRoles bound to the agent-broker ServiceAccount. They cap what any
            approval can do: `view` reads everything but Secrets; add `edit`
            (or your own role) before approved writes can succeed.
          '';
        };
      };
    };
    kubeconfig = mkOption {
      description = "A kubeconfig held in a Kubernetes Secret.";
      type = types.submodule {
        options = {
          secret = clib.mkSecretOption {
            key = "config";
            holds = "the kubeconfig";
            description = ''
              The kubeconfig. Tokens and client certificates only: a user with
              an `exec` plugin or `auth-provider` is refused, since it would run
              a binary in the broker.
            '';
          };
          context = mkOption {
            type = types.str;
            default = "";
            description = "Context to use; empty means the kubeconfig's current-context.";
          };
        };
      };
    };
  };

  clusterType = types.submodule {
    options = {
      auth = mkOption {
        type = authType;
        example = lib.literalExpression "{ inCluster = { }; }";
        description = "How the broker authenticates to this cluster. Set exactly one.";
      };
      defaultNamespace = mkOption {
        type = types.str;
        default = "default";
        description = "Namespace the tools use when the agent names none.";
      };
      readOnly = mkOption {
        type = types.bool;
        default = false;
        description = "Refuse every write, exec and Secret reveal before raising a card.";
      };
      approvers = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = [ "admin@example.com" ];
        description = ''
          User ids or emails who may approve this cluster's requests. Empty means
          the conversation's owner. When set, the owner may approve only if listed.
        '';
      };
      impersonate = {
        user = mkOption {
          type = types.nullOr types.str;
          default = null;
          example = "scooter-k8s";
          description = ''
            A Kubernetes username that writes, exec and Secret reads run as, via
            impersonation, so the broker's own identity can stay on `view`. Reads
            still run as the broker. Null runs everything as the broker. The audit
            log records each call with the conversation and approver as extras.
            For `inCluster`, the broker is allowed to impersonate this user;
            for `kubeconfig`, grant that kubeconfig's user `impersonate` yourself.
          '';
        };
        clusterRoles = mkOption {
          type = types.listOf types.str;
          default = [ ];
          example = [ "edit" ];
          description = "ClusterRoles bound cluster-wide to `impersonate.user`. `inCluster` only.";
        };
        namespaceRoles = mkOption {
          type = types.attrsOf (types.listOf types.str);
          default = { };
          example = { agent-sandbox = [ "edit" ]; };
          description = ''
            ClusterRoles bound to `impersonate.user` in one namespace each, by
            namespace. `edit` covers exec and Secret reads. `inCluster` only.
          '';
        };
      };
      grants = {
        enable = mkOption {
          type = types.bool;
          default = false;
          description = ''
            Let the agent ask for a time-limited write grant on one namespace.
            While it lasts, that conversation's apply, delete, scale and rollout
            restart in the namespace run without a card. Exec, Secret reveals and
            cluster-scoped objects always need their own approval.
          '';
        };
        maxMinutes = mkOption {
          type = types.ints.between 1 1440;
          default = 60;
          description = "Longest grant the agent may ask for, in minutes.";
        };
      };
    };
  };
in
{
  contribs.k8s = { config, ... }: {
    options.clusters = mkOption {
      type = types.attrsOf clusterType;
      default = { };
      example = lib.literalExpression ''
        {
          home.auth.inCluster = { };
          prod = {
            auth.kubeconfig.secret.name = "k8s-prod-kubeconfig";
            approvers = [ "admin@example.com" ];
          };
        }
      '';
      description = ''
        Clusters the agent may reach, by name (lowercase letters, digits and
        dashes). The name is what the agent passes as `cluster`.
      '';
    };

    config = {
      src = ./.;

      # Its own database (contrib_k8s).
      db = {
        enable = true;
        tables.k8s_grants = { };
      };

      services.broker = {
        enable = true;
        pythonDeps = ps: [ ps.kubernetes ps.pyyaml ];
        env = {
          # No clusters: tools stay off, so shipping enabled is safe.
          K8S_ENABLED = lib.boolToString (config.clusters != { });
          K8S_CLUSTERS_JSON = builtins.toJSON (lib.mapAttrs' (name: c: lib.nameValuePair (checkName name) {
            auth =
              if c.auth ? inCluster then { type = "inCluster"; }
              else { type = "kubeconfig"; env = kubeconfigEnv name; context = c.auth.kubeconfig.context; };
            default_namespace = c.defaultNamespace;
            read_only = c.readOnly;
            inherit (c) approvers;
            impersonate = impersonateUser name c;
            grants = { enable = c.grants.enable; max_minutes = c.grants.maxMinutes; };
          }) config.clusters);
        } // lib.mapAttrs' (name: c: lib.nameValuePair (kubeconfigEnv name) c.auth.kubeconfig.secret)
          (lib.filterAttrs (_: c: c.auth ? kubeconfig) config.clusters);
      };

      # Writes, exec and reveals are approved in-conversation, at /k8s/approvals.
      approvals = { };

      skills."scooter-k8s.md" = ./skills/scooter-k8s.md;

      ui.source = { label = "Kubernetes"; icon = ./icon.svg; };
    };
  };
}
