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

  # The pool version KEY = the sandbox image's content tag (the part after the last ':').
  # The controller keys/GCs PVCs by this; the provisioner claim hook must derive it the
  # SAME way from the same cfg.sandboxImage so tags match exactly (the no-fixup invariant).
  imageTag = lib.last (lib.splitString ":" cfg.sandboxImage);
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
      default = 2;
      description = "Controller replicas (leader-elected; >1 for availability, only the leader reconciles).";
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
                  # The pool version key — the current sandbox image's content tag. The warm
                  # Job boots the FULL image ref; the controller keys/GCs PVCs by the tag.
                  { name = "SANDBOX_IMAGE_TAG"; value = imageTag; }
                  { name = "SANDBOX_IMAGE"; value = cfg.sandboxImage; }
                  { name = "WARM_STORE_MIN_READY"; value = toString wcfg.minReady; }
                  { name = "WARM_STORE_MAX_TOTAL"; value = toString wcfg.maxTotal; }
                  { name = "WARM_STORE_STORAGE"; value = wcfg.storage; }
                  { name = "WARM_STORE_GOLDEN_EXPR"; value = wcfg.goldenExpr; }
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
