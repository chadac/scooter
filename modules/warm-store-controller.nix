# The warm /nix/store PVC pool controller (Deployment + SA + RBAC).
#
# A leader-elected reconcile loop that keeps a pool of overlay-upper PVCs warmed against
# the CURRENT sandbox image tag: tops up (warm Jobs), GCs retired tags, returns claimed
# PVCs on suspend, recovers leaks. Runs ALONGSIDE the upstream agent-sandbox controller
# (which owns the Sandbox→pod/PVC lifecycle — we install it from a release, don't fork).
# The agent-host provisioner does the CLAIM (claimName swap). See
# todo/docs/WARM_STORE_PVC_MANAGER.md.
#
# OFF by default (`agentSandbox.warmStore.enable`): a fresh conversation always gets a
# working (empty) overlay upper without it — the pool is a hit-rate optimization, not a
# correctness dependency.

{ config, lib, ... }:

let
  cfg = config.agentSandbox;
  wcfg = cfg.warmStore;
in
{
  options.agentSandbox.warmStore = with lib; {
    enable = mkEnableOption "the warm /nix/store PVC pool controller";

    image = mkOption {
      type = types.str;
      default = "${cfg.registryPrefix}warm-store-controller:latest";
      defaultText = literalExpression ''"''${registryPrefix}warm-store-controller:latest"'';
      description = "OCI ref of the warm-store-controller image.";
    };
    replicas = mkOption {
      type = types.int;
      default = 1;
      description = ''
        Controller replicas. Default 1: the controller is leader-elected (only the leader
        reconciles), so a 2nd replica only buys faster failover — not worth it for a pool
        controller whose work is a hit-rate optimization (a brief reconcile gap on pod
        restart just delays a warm/GC, never blocks a conversation). Set >1 for HA.
      '';
    };
    minReady = mkOption {
      type = types.int;
      default = 1;
      description = "Keep at least this many `ready` pool PVCs warmed for the current image tag.";
    };
    maxTotal = mkOption {
      type = types.int;
      default = 8;
      description = "Cap total `ready` pool PVCs for the current tag (LRU-evict the coldest past this).";
    };
    storage = mkOption {
      type = types.str;
      default = "20Gi";
      description = "Size of each pool PVC (the overlay upper). Match the per-conversation scooter-rw size.";
    };
    storageClass = mkOption {
      type = types.str;
      default = "warm-store-retain";
      description = ''
        StorageClass for POOL volumes. MUST have `reclaimPolicy: Retain`: on a Delete class
        removing a PVC destroys its PV, so nothing is ever recycled and the pool silently
        degrades to "always a fresh empty upper" with no symptom. The module creates this
        class from `storageProvisioner` unless `createStorageClass` is false (bring your own).
      '';
    };
    createStorageClass = mkOption {
      type = types.bool;
      default = true;
      description = "Create the Retain StorageClass. Set false to point `storageClass` at an existing one.";
    };
    storageProvisioner = mkOption {
      type = types.str;
      default = "rancher.io/local-path";
      description = ''
        Provisioner backing the pool StorageClass. A Retain variant of the cluster's normal
        provisioner is the point — no new CSI driver is needed, just a second class over the
        same one (e.g. ebs.csi.aws.com on EKS).
      '';
    };
    goldenExpr = mkOption {
      type = types.str;
      default = "";
      example = ''nixpkgs#awscli2 nixpkgs#nodejs nixpkgs#python3'';
      description = ''
        The golden seed: a Nix expression / installable spec the warm Job builds into the
        overlay upper (via the sandbox image's nix, landing in `upper/` + registered in
        `state/`). Empty ⇒ a minimal warm (a valid empty upper — the pool then self-enriches
        as conversations install tools and return their PVCs on suspend). This is the ONLY
        knob for "what golden tools to pre-warm".
      '';
    };
    reconcileInterval = mkOption {
      type = types.int;
      default = 10;
      description = "Seconds between reconcile passes (also the Lease renew cadence; < leaseSeconds).";
    };
    leaseSeconds = mkOption {
      type = types.int;
      default = 30;
      description = "Leader-election Lease duration; the holder must renew within this window.";
    };
  };

  config = lib.mkIf wcfg.enable {
    kubernetes.resources = {
      # --- the pool StorageClass (Retain) ---------------------------------
      # WaitForFirstConsumer matches the default class: the PV is provisioned where the pod
      # actually lands, and its nodeAffinity then records that topology — which is exactly
      # what the controller's placement predicate reads back when deciding reuse.
      storageClasses = lib.mkIf wcfg.createStorageClass {
        ${wcfg.storageClass} = {
          metadata.name = wcfg.storageClass;
          provisioner = wcfg.storageProvisioner;
          reclaimPolicy = "Retain";
          volumeBindingMode = "WaitForFirstConsumer";
        };
      };

      # --- SA + RBAC ------------------------------------------------------
      # Manage pool PVCs, run warm Jobs, watch Sandboxes (return/leak signals) + pods
      # (RWO bound-ness), and hold a leader-election Lease.
      serviceAccounts.warm-store-controller.metadata = {
        name = "warm-store-controller";
        namespace = cfg.namespace;
      };
      roles.warm-store-controller = {
        metadata = { name = "warm-store-controller"; namespace = cfg.namespace; };
        rules = [
          { apiGroups = [ "" ]; resources = [ "persistentvolumeclaims" ]; verbs = [ "get" "list" "watch" "create" "update" "patch" "delete" ]; }
          { apiGroups = [ "batch" ]; resources = [ "jobs" ]; verbs = [ "get" "list" "watch" "create" "delete" ]; }
          # The upstream Sandbox CRs — READ-ONLY (return/leak signals; source of truth for suspended).
          { apiGroups = [ "agents.x-k8s.io" ]; resources = [ "sandboxes" ]; verbs = [ "get" "list" "watch" ]; }
          # Pods — READ-ONLY: which PVCs are currently mounted (RWO single-attach truth).
          { apiGroups = [ "" ]; resources = [ "pods" ]; verbs = [ "get" "list" "watch" ]; }
          { apiGroups = [ "coordination.k8s.io" ]; resources = [ "leases" ]; verbs = [ "get" "list" "watch" "create" "update" ]; }
        ];
      };
      # PVs and Nodes are CLUSTER-scoped — a namespaced Role cannot grant them, so PV
      # placement needs its own ClusterRole. Kept minimal and separate from the namespaced
      # Role above so the blast radius of each is obvious.
      clusterRoles.warm-store-controller = {
        metadata.name = "warm-store-controller";
        rules = [
          # Pool PVs: list/watch to see the pool, patch to set/clear claimRef (the
          # reservation), update to manage the finalizer that makes them ours exclusively.
          { apiGroups = [ "" ]; resources = [ "persistentvolumes" ]; verbs = [ "get" "list" "watch" "patch" "update" ]; }
          # Nodes: READ-ONLY. The placement predicate matches a PV's nodeAffinity against
          # node labels, and must skip cordoned nodes (a PV pinned to one is unusable).
          { apiGroups = [ "" ]; resources = [ "nodes" ]; verbs = [ "get" "list" "watch" ]; }
        ];
      };
      clusterRoleBindings.warm-store-controller = {
        metadata.name = "warm-store-controller";
        roleRef = { apiGroup = "rbac.authorization.k8s.io"; kind = "ClusterRole"; name = "warm-store-controller"; };
        subjects = [{ kind = "ServiceAccount"; name = "warm-store-controller"; namespace = cfg.namespace; }];
      };

      roleBindings.warm-store-controller = {
        metadata = { name = "warm-store-controller"; namespace = cfg.namespace; };
        roleRef = { apiGroup = "rbac.authorization.k8s.io"; kind = "Role"; name = "warm-store-controller"; };
        subjects = [{ kind = "ServiceAccount"; name = "warm-store-controller"; namespace = cfg.namespace; }];
      };

      # --- the controller Deployment --------------------------------------
      deployments.warm-store-controller = {
        metadata = { name = "warm-store-controller"; namespace = cfg.namespace; };
        spec = {
          replicas = wcfg.replicas;
          selector.matchLabels.app = "warm-store-controller";
          template = {
            metadata.labels.app = "warm-store-controller";
            spec = {
              serviceAccountName = "warm-store-controller";
              containers.controller = {
                name = "controller";
                image = wcfg.image;
                imagePullPolicy = cfg.pullPolicy;
                command = [ "warm-store-controller" ];
                env = [
                  { name = "NAMESPACE"; value = cfg.namespace; }
                  # The pool version key is the sandbox image's TAG — the controller DERIVES it
                  # from SANDBOX_IMAGE at runtime (imageTagOf), the same ref the provisioner
                  # claims by, so they always agree even when a deploy rewrites …:latest →
                  # …:git-<sha> (which a separately-computed SANDBOX_IMAGE_TAG would miss).
                  { name = "SANDBOX_IMAGE"; value = cfg.sandboxImage; }
                  { name = "WARM_STORE_MIN_READY"; value = toString wcfg.minReady; }
                  { name = "WARM_STORE_MAX_TOTAL"; value = toString wcfg.maxTotal; }
                  { name = "WARM_STORE_STORAGE"; value = wcfg.storage; }
                  { name = "WARM_STORE_STORAGE_CLASS"; value = wcfg.storageClass; }
                  { name = "WARM_STORE_GOLDEN_EXPR"; value = wcfg.goldenExpr; }
                ]
                # The warm Job's systemd pod needs the SAME runtimeClass as the per-conversation
                # sandboxes (crun) — non-privileged systemd PID 1 in a private cgroup ns. Omit
                # when unset (cluster default).
                ++ lib.optional (cfg.sandboxRuntimeClass != null)
                  { name = "SANDBOX_RUNTIME_CLASS"; value = cfg.sandboxRuntimeClass; }
                ++ [
                  { name = "RECONCILE_INTERVAL_SECONDS"; value = toString wcfg.reconcileInterval; }
                  { name = "LEASE_DURATION_SECONDS"; value = toString wcfg.leaseSeconds; }
                  # Pod name → the leader-election Lease holder identity.
                  { name = "POD_NAME"; valueFrom.fieldRef.fieldPath = "metadata.name"; }
                ];
                resources = lib.mkDefault {
                  requests = { cpu = "25m"; memory = "64Mi"; };
                  limits = { cpu = "50m"; memory = "128Mi"; };
                };
              };
            };
          };
        };
      };
    };
  };
}
