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
                    sandboxRef = { type = "string"; };
                  };
                };
                status = {
                  type = "object";
                  properties = {
                    phase = { type = "string"; };       # Pending | Assigned | Orphaned
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
          { apiGroups = [ "" ]; resources = [ "pods" ]; verbs = [ "get" "list" "watch" ]; }
          { apiGroups = [ "coordination.k8s.io" ]; resources = [ "leases" ]; verbs = [ "get" "list" "watch" "create" "update" ]; }
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
                ];
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
          # Read-only: the router only READS status.hostPod (the controller writes it).
          { apiGroups = [ "scooter.chadac.dev" ]; resources = [ "conversations" ]; verbs = [ "get" "list" "watch" ]; }
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
                ];
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
