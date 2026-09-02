# The Conversation CRD + its controller + router (Deployment + SA + RBAC).
#
# The CRD (scooter.chadac.dev/v1alpha1 Conversation) records which agent-host pod owns
# each conversation (status.hostPod) — the assignment table for multi-replica agent-host.
# The controller is a leader-elected reconcile loop that assigns/reassigns hostPod; the
# router reverse-proxies each request to the owning pod. ALWAYS ON — agent-host is a
# multi-replica StatefulSet fronted by the router (no single-replica path).

{ config, lib, ... }:

let
  cfg = config.agentSandbox;
  ccfg = cfg.conversationController;
in
{
  options.agentSandbox.conversationController = with lib; {
    image = mkOption {
      type = types.str;
      default = "${cfg.registryPrefix}conversation-controller:latest";
      defaultText = literalExpression ''"''${registryPrefix}conversation-controller:latest"'';
      description = "OCI ref of the conversation-controller image.";
    };
    replicas = mkOption {
      type = types.int;
      default = 2;
      description = "Controller replicas (leader-elected; >1 for availability, only the leader reconciles).";
    };
    podCap = mkOption {
      type = types.int;
      default = 100;
      description = "Max conversations assigned to one agent-host pod before it's considered full.";
    };
    reapOrphans = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Reap orphaned Sandboxes — those with no owning Conversation CR — destroying the whole
        per-conversation tree (Sandbox + its ServiceAccount + module ConfigMap). Fixes the leak
        where a Sandbox whose Conversation is gone is never cleaned up. See
        todo/docs/ORPHANED_SANDBOX_REAPER.md.
      '';
    };
    orphanGraceSeconds = mkOption {
      type = types.int;
      default = 600;
      description = ''
        Only reap a Sandbox with no owning Conversation if it's older than this many seconds —
        long enough that a normal create has registered its Conversation CR (the provisioner
        creates the Sandbox a beat before the CR), so only genuine orphans are reaped.
      '';
    };
    # --- agent-host autoscaling -------------------------------------------
    autoscale = mkOption {
      type = types.bool;
      default = true;
      description = ''
        The controller autoscales the agent-host Deployment to fit conversation demand
        (desired = ceil(top-level conversations / podCap), clamped to [minReplicas, maxReplicas]).
        The controller is the SINGLE writer of agent-host replicas — do NOT also attach an HPA
        to agent-host (two writers fight). A conversations-per-pod metric is still exported at
        :metricsPort/metrics for observability. See todo/docs/AGENT_HOST_FLEET_SCALING.md.
      '';
    };
    minReplicas = mkOption {
      type = types.int;
      default = 2;
      description = "Autoscaler floor — never scale the agent-host below this (a warm fleet).";
    };
    maxReplicas = mkOption {
      type = types.int;
      default = 10;
      description = "Autoscaler ceiling — never scale the agent-host above this.";
    };
    scaleDownCooldownSeconds = mkOption {
      type = types.int;
      default = 300;
      description = "Wait this long between scale-DOWNs (hysteresis; scale-up is immediate).";
    };
    metricsPort = mkOption {
      type = types.int;
      default = 9090;
      description = "Port the controller serves Prometheus /metrics on (conversations-per-pod).";
    };
    agentHostReplicas = mkOption {
      type = types.int;
      default = 2;
      description = "agent-host StatefulSet replicas when the controller is enabled (multi-replica).";
    };
    routerImage = mkOption {
      type = types.str;
      default = "${cfg.registryPrefix}conversation-router:latest";
      defaultText = literalExpression ''"''${registryPrefix}conversation-router:latest"'';
      description = "OCI ref of the conversation-router image.";
    };
    routerReplicas = mkOption {
      type = types.int;
      default = 2;
      description = "Router replicas (stateless proxy; fronts the agent-host Service).";
    };

    # --- history mirror (cross-pod conversation revival) --------------------
    # ONE shared append-only RWX volume every agent-host pod mirrors its events
    # to (async, off the hot path — see mirroredStore.ts + the CRD design doc).
    # After a conversation reassigns to a different pod, that pod reads the
    # conversation's history back from this volume. Multi-writer ⇒ ReadWriteMany.
    historyMirror = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = ''
          Provision the shared history-mirror PVC + wire MIRROR_STATE_PATH into
          agent-host. On by default: cross-pod history revival is the point of
          multi-replica. Set false on a cluster with no RWX (nothing shared —
          each pod keeps only its own local history; routing still works).
        '';
      };
      size = mkOption {
        type = types.str;
        default = "10Gi";
        description = "Size of the shared history-mirror PVC.";
      };
      accessMode = mkOption {
        type = types.str;
        default = "ReadWriteMany";
        description = ''
          Access mode of the mirror PVC. ReadWriteMany is required for the real
          multi-writer mirror (all pods append). Left configurable only for the
          degenerate replicas=1 case.
        '';
      };
      storageClassName = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = ''
          storageClassName for the mirror PVC (null = cluster default). Point at
          an RWX class (EFS/NFS) on a real cluster. Ignored when hostPath is set.
        '';
      };
      retainForMigration = mkOption {
        type = types.bool;
        default = false;
        description = ''
          Keep the mirror PVC provisioned while the event log migrates to
          Postgres, even once agent-host has stopped writing to it.

          The migration reads every conversation's events.jsonl OUT of this
          volume, so it must outlive the cutover: deleting the PVC in the same
          change that stops using it would destroy the only copy of any history
          the backfill had not yet loaded. Set this true BEFORE the cutover
          deploy, verify the backfill reported every conversation, then set it
          false (and drop the option) to reclaim the volume.

          Independent of `enable`: with enable = false and this true, the PVC
          exists but nothing mounts it — which is exactly the post-cutover,
          pre-reclaim state.
        '';
      };
      hostPath = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "/var/lib/scooter/agent-host-history";
        description = ''
          Single-node escape hatch (e.g. odin, which has no RWX provisioner):
          back the mirror with a hostPath PV at this path so a ReadWriteMany PVC
          binds. All agent-host pods land on the one node and share the host dir.
          Set null on a real multi-node cluster (use storageClassName instead).
        '';
      };
    };
  };

  config = {
    kubernetes.resources = {
      # --- the CRD ---------------------------------------------------------
      customResourceDefinitions.conversations = {
        metadata.name = "conversations.scooter.chadac.dev";
        spec = {
          group = "scooter.chadac.dev";
          scope = "Namespaced";
          names = {
            plural = "conversations";
            singular = "conversation";
            kind = "Conversation";
            shortNames = [ "conv" ];
          };
          versions = [{
            name = "v1alpha1";
            served = true;
            storage = true;
            subresources.status = { };  # status is a subresource (controller patches it)
            schema.openAPIV3Schema = {
              type = "object";
              properties = {
                spec = {
                  type = "object";
                  properties = {
                    model = { type = "string"; };
                    owner = { type = "string"; };
                    parentId = { type = "string"; };
                    creatorPod = { type = "string"; };
                    sandboxRef = { type = "string"; };
                  };
                };
                status = {
                  type = "object";
                  properties = {
                    # Pending | Assigned | Suspended | Orphaned. The controller owns the
                    # ASSIGNMENT phases (Pending → Assigned; Orphaned); agent-host publishes the
                    # LIVENESS of an assigned conversation (Assigned ⇄ Suspended) so it's visible
                    # in `kubectl get conversations`. See CONVERSATION_LIFECYCLE_CONTROLLER.md.
                    phase = { type = "string"; };
                    hostPod = { type = "string"; nullable = true; };  # owner pod NAME (fencing identity + debugging)
                    # Owner pod IP — the ROUTING ADDRESS. Deployments give random-named pods no
                    # stable DNS, so the router proxies to http://<hostIP>:<port> instead of a
                    # headless-Service DNS name. Re-derived by the controller on every (re)assign
                    # (ephemeral IPs are fine — the CR is the source of truth). Null when Pending.
                    # See todo/docs/ROLLOUT_DRAIN_AND_POD_IP.md.
                    hostIP = { type = "string"; nullable = true; };
                    assignedAt = { type = "string"; };
                    generation = { type = "integer"; };  # fence epoch, bumps per (re)assignment
                  };
                };
              };
            };
            additionalPrinterColumns = [
              { name = "Phase"; type = "string"; jsonPath = ".status.phase"; }
              { name = "Host"; type = "string"; jsonPath = ".status.hostPod"; }
              { name = "IP"; type = "string"; jsonPath = ".status.hostIP"; }
              { name = "Gen"; type = "integer"; jsonPath = ".status.generation"; }
            ];
          }];
        };
      };

      # --- SA + RBAC (patch Conversation status, watch pods, hold a Lease) --
      serviceAccounts.conversation-controller.metadata = {
        name = "conversation-controller";
        namespace = cfg.namespace;
      };
      roles.conversation-controller = {
        metadata = { name = "conversation-controller"; namespace = cfg.namespace; };
        rules = [
          { apiGroups = [ "scooter.chadac.dev" ]; resources = [ "conversations" "conversations/status" ]; verbs = [ "get" "list" "watch" "patch" "update" ]; }
          { apiGroups = [ "" ]; resources = [ "pods" ]; verbs = [ "get" "list" "watch" "patch" ]; }  # patch: pod-deletion-cost annotation (scale-down victim steering)
          { apiGroups = [ "coordination.k8s.io" ]; resources = [ "leases" ]; verbs = [ "get" "list" "watch" "create" "update" ]; }
          # Orphaned-Sandbox reaper: list Sandboxes + DELETE the whole per-conversation tree
          # (Sandbox CR cascades pod+PVCs; the SA + module CM are provisioner-created and must
          # be deleted directly). See todo/docs/ORPHANED_SANDBOX_REAPER.md.
          { apiGroups = [ "agents.x-k8s.io" ]; resources = [ "sandboxes" ]; verbs = [ "get" "list" "watch" "delete" "patch" ]; }
          { apiGroups = [ "" ]; resources = [ "serviceaccounts" "configmaps" ]; verbs = [ "get" "list" "delete" ]; }
          # Autoscaler: read the agent-host Deployment + patch its scale subresource (the
          # controller IS the autoscaler — desired = ceil(conversations / podCap)). See
          # todo/docs/AGENT_HOST_FLEET_SCALING.md.
          { apiGroups = [ "apps" ]; resources = [ "deployments" ]; verbs = [ "get" "list" "watch" ]; }
          { apiGroups = [ "apps" ]; resources = [ "deployments/scale" ]; verbs = [ "get" "patch" "update" ]; }
        ];
      };
      roleBindings.conversation-controller = {
        metadata = { name = "conversation-controller"; namespace = cfg.namespace; };
        roleRef = { apiGroup = "rbac.authorization.k8s.io"; kind = "Role"; name = "conversation-controller"; };
        subjects = [{ kind = "ServiceAccount"; name = "conversation-controller"; namespace = cfg.namespace; }];
      };

      # --- the controller Deployment --------------------------------------
      deployments.conversation-controller = {
        metadata = { name = "conversation-controller"; namespace = cfg.namespace; };
        spec = {
          replicas = ccfg.replicas;
          selector.matchLabels.app = "conversation-controller";
          template = {
            metadata.labels.app = "conversation-controller";
            spec = {
              serviceAccountName = "conversation-controller";
              containers.controller = {
                name = "controller";
                image = ccfg.image;
                imagePullPolicy = cfg.pullPolicy;
                command = [ "conversation-controller" ];
                env = [
                  { name = "NAMESPACE"; value = cfg.namespace; }
                  { name = "CONVERSATION_POD_CAP"; value = toString ccfg.podCap; }
                  # Pod name → the leader-election Lease holder identity.
                  { name = "POD_NAME"; valueFrom.fieldRef.fieldPath = "metadata.name"; }
                  # Orphaned-Sandbox reaper (leader-only).
                  { name = "REAP_ORPHANED_SANDBOXES"; value = if ccfg.reapOrphans then "1" else "0"; }
                  { name = "ORPHAN_GRACE_SECONDS"; value = toString ccfg.orphanGraceSeconds; }
                  # Agent-host autoscaler (leader-only, single writer of agent-host replicas).
                  { name = "AUTOSCALE_AGENT_HOST"; value = if ccfg.autoscale then "1" else "0"; }
                  { name = "AGENT_HOST_MIN_REPLICAS"; value = toString ccfg.minReplicas; }
                  { name = "AGENT_HOST_MAX_REPLICAS"; value = toString ccfg.maxReplicas; }
                  { name = "SCALE_DOWN_COOLDOWN_SECONDS"; value = toString ccfg.scaleDownCooldownSeconds; }
                  { name = "METRICS_PORT"; value = toString ccfg.metricsPort; }
                ];
                ports = [{ name = "metrics"; containerPort = ccfg.metricsPort; }];
                resources = lib.mkDefault {
                  requests = { cpu = "25m"; memory = "64Mi"; };
                  limits = { cpu = "25m"; memory = "64Mi"; };
                };
              };
            };
          };
        };
      };

      # --- the ROUTER: SA + RBAC (watch Conversations for the cache) + Deployment ----
      serviceAccounts.conversation-router.metadata = {
        name = "conversation-router";
        namespace = cfg.namespace;
      };
      roles.conversation-router = {
        metadata = { name = "conversation-router"; namespace = cfg.namespace; };
        rules = [
          # READS status.hostPod for routing (the controller writes it), and CREATES the CR:
          # POST /conversations is served by the ROUTER, not proxied to an agent-host. The
          # agent-host fleet is capacity-bounded (the controller leaves a conversation Pending
          # when every pod is at cap), so creating there made conversation replicas*cap+1
          # uncreatable — its id would be minted by the component that could not host it.
          # Creating the CR here consults no agent-host; `Pending` is then a normal state.
          # Still NO update/patch/delete: assignment and lifecycle stay the controller's.
          { apiGroups = [ "scooter.chadac.dev" ]; resources = [ "conversations" ]; verbs = [ "get" "list" "watch" "create" ]; }
        ];
      };
      roleBindings.conversation-router = {
        metadata = { name = "conversation-router"; namespace = cfg.namespace; };
        roleRef = { apiGroup = "rbac.authorization.k8s.io"; kind = "Role"; name = "conversation-router"; };
        subjects = [{ kind = "ServiceAccount"; name = "conversation-router"; namespace = cfg.namespace; }];
      };
      deployments.conversation-router = {
        metadata = { name = "conversation-router"; namespace = cfg.namespace; };
        spec = {
          replicas = ccfg.routerReplicas;   # stateless proxy — safe to run several
          selector.matchLabels.app = "conversation-router";
          template = {
            metadata.labels.app = "conversation-router";
            spec = {
              serviceAccountName = "conversation-router";
              containers.router = {
                name = "router";
                image = ccfg.routerImage;
                imagePullPolicy = cfg.pullPolicy;
                command = [ "conversation-router" ];
                ports = [{ containerPort = 8080; name = "agui"; }];
                env = [
                  { name = "NAMESPACE"; value = cfg.namespace; }
                  # Route by POD IP, not headless-Service DNS: the router reads status.hostIP
                  # from the CR and proxies http://<ip>:port. AGENT_HOST_SERVICE is the
                  # ClusterIP Service selecting the agent-host PODS — the router's FALLBACK for
                  # non-scoped / unassigned / stale-IP requests (any ready pod). It must select
                  # the pods, NOT `agent-host` (that fronts the router → a loop). See
                  # todo/docs/ROLLOUT_DRAIN_AND_POD_IP.md.
                  { name = "AGENT_HOST_SERVICE"; value = "agent-host-pods"; }
                  { name = "UPSTREAM_PORT"; value = "8080"; }
                  { name = "LISTEN_ADDR"; value = ":8080"; }
                  # READ-ONLY handle on the agent_host database (conversation metadata). Same
                  # AGENT_HOST_DB_* names agent-host reads, but the credentials are the router's
                  # own `conversation_router` role — granted only SELECT and pinned
                  # default_transaction_read_only (see modules/postgres.nix readers). Lets the
                  # router serve the durable conversation list without fanning out to every pod.
                  { name = "AGENT_HOST_DB_HOST"; value = cfg.postgres.host; }
                  { name = "AGENT_HOST_DB_PORT"; value = toString cfg.postgres.port; }
                  { name = "AGENT_HOST_DB_NAME"; value = "agent_host"; }
                  { name = "AGENT_HOST_DB_USER"; value = "conversation_router"; }
                  { name = "AGENT_HOST_DB_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-conversation-router"; key = "password"; }; }
                ] ++ lib.optional (cfg.postgres.sslmode != null) { name = "AGENT_HOST_DB_SSLMODE"; value = cfg.postgres.sslmode; };
                readinessProbe.httpGet = { path = "/healthz"; port = "agui"; };
                resources = lib.mkDefault {
                  requests = { cpu = "50m"; memory = "64Mi"; };
                  limits = { memory = "128Mi"; };
                };
              };
            };
          };
        };
      };
    };
  };
}
