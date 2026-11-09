# Warm /nix/store pool controller; off by default, a hit-rate optimization.

{ config, lib, ... }:

let
  cfg = config.scooter;
  wcfg = cfg.warmStore;
in
{
  imports = [
    (lib.mkRenamedOptionModule [ "scooter" "warmStore" "minReady" ] [ "scooter" "warmStore" "minWarm" ])
    (lib.mkRenamedOptionModule [ "scooter" "warmStore" "maxTotal" ] [ "scooter" "warmStore" "maxWarm" ])
  ];

  options.scooter.warmStore = with lib; {
    enable = mkEnableOption "the warm /nix/store PVC pool controller";

    image = mkOption {
      type = types.str;
      default = cfg.images.warm-store-controller.pod.image;
      defaultText = literalExpression "config.scooter.images.warm-store-controller.pod.image";
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
    resources = mkOption {
      type = types.attrs;
      default = {
        requests = { cpu = "50m"; memory = "128Mi"; };
        limits = { cpu = "500m"; memory = "256Mi"; };
      };
      description = ''
        The controller container's resources. /reserve deserializes every PV under
        the lock and has a 2s client budget; at a 50m limit it took ~24s (#974).
      '';
    };
    minWarm = mkOption {
      type = types.int;
      default = 1;
      description = "Floor on the number of idle pool volumes kept for the current image tag.";
    };
    maxWarm = mkOption {
      type = types.int;
      default = 8;
      description = "Hard cap on the idle-volume target, whatever the sizing policy asks for.";
    };
    maxWarmJobs = mkOption {
      type = types.int;
      default = 2;
      description = "Warm Jobs (each a full sandbox boot) allowed to run at once.";
    };
    cooldown = mkOption {
      type = types.int;
      default = 1800;
      description = "Seconds the pool must stay above its target before it shrinks, one volume per pass.";
    };
    sizing = {
      policy = mkOption {
        type = types.enum [ "reactive" "fixed" ];
        default = "reactive";
        description = ''
          How the warm target is set. `fixed` keeps `minWarm` idle volumes. `reactive` keeps
          the expected arrivals over one warm-Job duration (times `headroom`) plus recent
          misses, between `minWarm` and `maxWarm`, split across nodes by where sandboxes land.
        '';
      };
      reactive = {
        window = mkOption {
          type = types.int;
          default = 900;
          description = "Seconds of sandbox arrivals and misses the reactive policy looks at.";
        };
        headroom = mkOption {
          type = types.str;
          default = "1.5";
          description = "Multiplier on expected arrivals (a decimal string).";
        };
      };
    };
    maxReturned = mkOption {
      type = types.int;
      default = 5;
      description = "Cap on idle volumes released by suspended sandboxes; the longest idle are wiped first.";
    };
    returnedTtl = mkOption {
      type = types.int;
      default = 86400;
      description = "Seconds an idle returned volume is kept before it is wiped.";
    };
    markerRetries = mkOption {
      type = types.int;
      default = 3;
      description = "Failed clean-shutdown checks before a released volume is wiped instead of reused.";
    };
    reserveTimeoutMs = mkOption {
      type = types.int;
      default = 2000;
      description = "How long the agent-host waits on /reserve before starting the sandbox on a fresh volume.";
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
        degrades to "always a fresh empty upper" with no symptom.

        Created by this module over `storageProvisioner`. Point it at a class you manage
        yourself by also setting `storageProvisioner = null`.
      '';
    };
    storageProvisioner = mkOption {
      type = types.nullOr types.str;
      default = "rancher.io/local-path";
      description = ''
        Provisioner backing the pool StorageClass — a Retain variant of the cluster's normal
        one, so no new CSI driver is needed (e.g. `ebs.csi.aws.com` on EKS). null ⇒ do not
        create the class; `storageClass` must then already exist.
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

  config = lib.mkMerge [
    (lib.mkIf wcfg.enable {
    kubernetes.resources = {
      # --- the pool StorageClass (Retain) ---------------------------------
      # WaitForFirstConsumer makes the PV record the topology the predicate reads back.
      storageClasses = lib.mkIf (wcfg.storageProvisioner != null) {
        ${wcfg.storageClass} = {
          metadata.name = wcfg.storageClass;
          provisioner = wcfg.storageProvisioner;
          reclaimPolicy = "Retain";
          volumeBindingMode = "WaitForFirstConsumer";
        };
      };

      # --- SA + RBAC ------------------------------------------------------
      serviceAccounts.warm-store-controller.metadata = {
        name = "warm-store-controller";
        namespace = cfg.namespace;
      };
      roles.warm-store-controller = {
        metadata = { name = "warm-store-controller"; namespace = cfg.namespace; };
        rules = [
          { apiGroups = [ "" ]; resources = [ "persistentvolumeclaims" ]; verbs = [ "get" "list" "watch" "create" "update" "patch" "delete" ]; }
          # deletecollection clears a sandbox's marker-check Jobs by label.
          { apiGroups = [ "batch" ]; resources = [ "jobs" "jobs/status" ]; verbs = [ "get" "list" "watch" "create" "delete" "deletecollection" ]; }
          # Read for suspend state, image tag and arrival times.
          { apiGroups = [ "agents.x-k8s.io" ]; resources = [ "sandboxes" ]; verbs = [ "get" "list" "watch" ]; }
          # Pods are read to learn which PVCs are currently mounted.
          { apiGroups = [ "" ]; resources = [ "pods" ]; verbs = [ "get" "list" "watch" ]; }
          { apiGroups = [ "coordination.k8s.io" ]; resources = [ "leases" ]; verbs = [ "get" "list" "watch" "create" "update" ]; }
        ];
      };
      # PVs and Nodes are cluster-scoped, beyond the namespaced Role above.
      clusterRoles.warm-store-controller = {
        metadata.name = "warm-store-controller";
        rules = [
          # patch sets and clears claimRef and the reclaim policy.
          { apiGroups = [ "" ]; resources = [ "persistentvolumes" ]; verbs = [ "get" "list" "watch" "patch" "update" ]; }
          # Candidates are matched to schedulable nodes by PV nodeAffinity.
          { apiGroups = [ "" ]; resources = [ "nodes" ]; verbs = [ "get" "list" "watch" ]; }
          # /reserve authenticates the agent-host's projected token.
          { apiGroups = [ "authentication.k8s.io" ]; resources = [ "tokenreviews" ]; verbs = [ "create" ]; }
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

      services.warm-store-controller = {
        metadata = { name = "warm-store-controller"; namespace = cfg.namespace; };
        spec = {
          selector.app = "warm-store-controller";
          ports = [{ name = "http"; port = 8080; targetPort = "http"; }];
        };
      };

      # --- the controller Deployment --------------------------------------
      deployments.warm-store-controller = {
        metadata = { name = "warm-store-controller"; namespace = cfg.namespace; };
        spec = {
          replicas = wcfg.replicas;
          # Only the leader is Ready, so a surge pod never would be.
          strategy.type = "Recreate";
          selector.matchLabels.app = "warm-store-controller";
          template = cfg.imageless.wrapPod "warm-store-controller" "controller" {
            metadata.labels.app = "warm-store-controller";
            spec = {
              serviceAccountName = "warm-store-controller";
              containers.controller = {
                name = "controller";
                image = wcfg.image;
                imagePullPolicy = cfg.pullPolicy;
                command = [ "warm-store-controller" ];
                ports = [{ name = "http"; containerPort = 8080; }];
                # Only the leader is Ready, so /reserve reaches it alone.
                readinessProbe = { httpGet = { path = "/readyz"; port = "http"; }; periodSeconds = 5; };
                livenessProbe = { httpGet = { path = "/healthz"; port = "http"; }; periodSeconds = 20; };
                env = [
                  { name = "NAMESPACE"; value = cfg.namespace; }
                  # The controller derives the pool version key from this ref, the same one the provisioner claims by.
                  { name = "SANDBOX_IMAGE"; value = cfg.sandboxImage; }
                  { name = "WARM_STORE_MIN_WARM"; value = toString wcfg.minWarm; }
                  { name = "WARM_STORE_MAX_WARM"; value = toString wcfg.maxWarm; }
                  { name = "WARM_STORE_MAX_WARM_JOBS"; value = toString wcfg.maxWarmJobs; }
                  { name = "WARM_STORE_COOLDOWN_SECONDS"; value = toString wcfg.cooldown; }
                  { name = "WARM_STORE_SIZING_POLICY"; value = wcfg.sizing.policy; }
                  { name = "WARM_STORE_SIZING_WINDOW_SECONDS"; value = toString wcfg.sizing.reactive.window; }
                  { name = "WARM_STORE_SIZING_HEADROOM"; value = wcfg.sizing.reactive.headroom; }
                  { name = "WARM_STORE_MAX_RETURNED"; value = toString wcfg.maxReturned; }
                  { name = "WARM_STORE_RETURNED_TTL_SECONDS"; value = toString wcfg.returnedTtl; }
                  { name = "WARM_STORE_MARKER_RETRIES"; value = toString wcfg.markerRetries; }
                  { name = "WARM_STORE_ALLOWED_SUBJECTS"; value = "system:serviceaccount:${cfg.namespace}:agent-host"; }
                  { name = "WARM_STORE_STORAGE"; value = wcfg.storage; }
                  { name = "WARM_STORE_STORAGE_CLASS"; value = wcfg.storageClass; }
                  { name = "WARM_STORE_GOLDEN_EXPR"; value = wcfg.goldenExpr; }
                ]
                # The warm Job's systemd pod needs the same runtimeClass as the per-conversation sandboxes.
                ++ lib.optional (cfg.sandboxRuntimeClass != null)
                  { name = "SANDBOX_RUNTIME_CLASS"; value = cfg.sandboxRuntimeClass; }
                # The warm Job boots the sandbox, so shares its wiring.
                ++ lib.optional (cfg.images.agent-sandbox-os.source == "imageless")
                  { name = "SANDBOX_IMAGELESS_POD"; value = builtins.toJSON cfg.imageless.sandboxPod; }
                # The warm Job boots the same image, so it gets the same user-namespace posture.
                ++ lib.optional cfg.sandboxUserNamespace
                  { name = "SANDBOX_USER_NAMESPACE"; value = "1"; }
                ++ [
                  { name = "RECONCILE_INTERVAL_SECONDS"; value = toString wcfg.reconcileInterval; }
                  { name = "LEASE_DURATION_SECONDS"; value = toString wcfg.leaseSeconds; }
                  # The leader-election Lease holder identity.
                  { name = "POD_NAME"; valueFrom.fieldRef.fieldPath = "metadata.name"; }
                ];
                resources = wcfg.resources;
              };
            };
          };
        };
      };
    };
  })
  ];
}
