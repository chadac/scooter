# The conversation controller and the router.
#
# The `conversations` row (agent_host database) records which agent-host pod owns
# each conversation; the leader-elected controller assigns and reassigns host_pod,
# and the router claims unassigned rows and reverse-proxies each request to the
# owning pod. Both are always on.

{ config, lib, ... }:

let
  cfg = config.scooter;
  ccfg = cfg.conversationController;
  # The router's sandbox-host listener. Must differ from the main (8080) and
  # self-access listeners, or the second bind fails and the router crash-loops.
  sandboxPort = 8082;
  routerPorts =
    if ccfg.selfAccess.enable && builtins.elem ccfg.selfAccess.port [ 8080 sandboxPort ] then
      # A `throw`, since kubenix has no `assertions` option.
      throw "scooter.conversationController.selfAccess.port = ${toString ccfg.selfAccess.port} collides with another conversation-router listener (8080 = main, ${toString sandboxPort} = sandbox hosts); pick a different port."
    else null;
  # Without a way to prove sessions, enforcing would refuse every browser.
  enforceAuth =
    if cfg.auth.mode == "alb-oidc" && cfg.auth.albRegion == null then
      throw "scooter.auth.enforce needs scooter.auth.albRegion in alb-oidc mode, or the router refuses every browser request."
    else if cfg.auth.mode == "header" && cfg.auth.sessionCheckUrl == null then
      throw "scooter.auth.enforce needs scooter.auth.sessionCheckUrl in header mode, or the router refuses every browser request."
    else "true";
in
{
  options.scooter.conversationController = with lib; {
    image = mkOption {
      type = types.str;
      default = cfg.images.conversation-controller.ref.fullUrl;
      defaultText = literalExpression "config.scooter.images.conversation-controller.ref.fullUrl";
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
        Reap orphaned Sandboxes — those no conversations row references — destroying the whole
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
        long enough that a normal create has recorded its sandbox_ref on the conversations row
        (the provisioner creates the Sandbox a beat before that write), so only genuine orphans
        are reaped.
      '';
    };
    overlayRetentionSeconds = mkOption {
      type = types.int;
      default = 7 * 86400;
      description = ''
        Delete a Sandbox's overlay-store PVC (`scooter-rw-*`, its runtime Nix builds) once
        it has been suspended this long. Resume recreates it empty, so only a slower first
        turn is lost. Workspaces are never touched. 0 disables.
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
      default = cfg.images.conversation-router.ref.fullUrl;
      defaultText = literalExpression "config.scooter.images.conversation-router.ref.fullUrl";
      description = "OCI ref of the conversation-router image.";
    };
    routerReplicas = mkOption {
      type = types.int;
      default = 2;
      description = "Router replicas (stateless proxy; fronts the agent-host Service).";
    };
    spawners = mkOption {
      type = types.listOf (types.strMatching "[a-z0-9]([-a-z0-9]*[a-z0-9])?");
      default = [ ];
      example = [ "agent-broker" ];
      description = ''
        ServiceAccounts (in the platform namespace) that may call
        `POST /conversations/{id}/spawns` on the router, which opens a new
        top-level conversation for that conversation's owner and queues its
        first message. Owner and visibility always come from the source
        conversation, and the route reads nothing back, so it is far
        narrower than the owner-asserting allowlist. The new conversation's
        agent still acts for that owner, so list only services already
        trusted with users' credentials (the broker). Each source may spawn
        at most `spawnsPerSourcePerHour` conversations per router replica.
        Empty disables the route.
      '';
    };
    spawnsPerSourcePerHour = mkOption {
      type = types.ints.positive;
      default = 10;
      description = "Per-source spawn cap, per router replica (SPAWNS_PER_SOURCE_PER_HOUR).";
    };

    # --- history mirror (cross-pod conversation revival) --------------------
    # One shared RWX volume every agent-host pod mirrors its events to, read back
    # by whichever pod a conversation is reassigned to.
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
    assets = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = ''
          Provision a dedicated PVC for asset storage (uploaded images, future media).
          BYTES-ONLY PVC: asset metadata (conversation_id, asset_id, mime_type, size,
          sha256_hash, created_at) lives in Postgres; the PVC holds only the raw image
          data, keyed by asset_id. Clean separation: queryable metadata in DB, efficient
          blob storage on disk. Lifecycle: assets are conversation-scoped and cleared
          when a conversation is deleted (metadata rows removed; orphaned bytes cleaned
          by GC job).

          Off means assets fall back to LOCAL_STATE_PATH (emptyDir, ephemeral — images
          are lost on pod restart).
        '';
      };
      size = mkOption {
        type = types.str;
        default = "10Gi";
        description = "Size of the dedicated assets PVC (10Gi ≈ 2000 images at 5MB each).";
      };
      accessMode = mkOption {
        type = types.str;
        default = "ReadWriteMany";
        description = ''
          Access mode of the assets PVC. ReadWriteMany because the multi-replica
          agent-host fleet all write assets and pods may land on different nodes
          (see #471). Left configurable for the degenerate single-node/RWO case.
        '';
      };
      storageClassName = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = ''
          storageClassName for the assets PVC (null = cluster default). Point at an
          RWX class (EFS/NFS) on a real multi-node cluster. Ignored when hostPath is set.
        '';
      };
      hostPath = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "/var/lib/scooter/agent-host-assets";
        description = ''
          Single-node escape hatch (e.g. k3d/odin, which have no RWX provisioner):
          back the assets PVC with a hostPath PV at this path so a ReadWriteMany claim
          binds. All agent-host pods land on the one node and share the host dir — the
          same mechanism historyMirror.hostPath uses. Set null on a real multi-node
          cluster (use storageClassName instead).
        '';
      };
    };

    # --- sandbox self-access ---------------------------------------------------
    # A sandbox pod calling its own conversation's API (VS Code continuing the
    # conversation) with its projected SA token, on a router port that never trusts
    # identity headers. See services/conversation-router/selfaccess.go.
    selfAccess = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = ''
          Serve the sandbox self-access listener on the router and give each sandbox a
          token for it (/var/run/secrets/<audience>/token) plus SCOOTER_SELF_URL. A pod
          may only read events/history and post messages/cancel on conversations it
          runs; it can never answer tool-permission prompts.
        '';
      };
      audience = mkOption {
        type = types.str;
        default = "scooter-self";
        description = "Audience of the projected token sandboxes present to the self-access listener.";
      };
      port = mkOption {
        type = types.port;
        default = 8081;
        description = "Router container port for the self-access listener (fronted by the conversation-router-self Service on 8080).";
      };
      messagesPerMinute = mkOption {
        type = types.int;
        default = 10;
        description = "Per-conversation cap on messages a sandbox may post (0 = unlimited), so the agent cannot drive itself in a loop.";
      };
    };

  };
  config = lib.mkMerge [
    ({
    kubernetes.resources = {
      # --- SA + RBAC (watch pods, hold a Lease, manage Sandboxes) ---------
      serviceAccounts.conversation-controller.metadata = {
        name = "conversation-controller";
        namespace = cfg.namespace;
      };
      roles.conversation-controller = {
        metadata = { name = "conversation-controller"; namespace = cfg.namespace; };
        rules = [
          # patch for the pod-deletion-cost annotation; delete for reclaiming a
          # leaked sandbox pod, never the Sandbox CR.
          { apiGroups = [ "" ]; resources = [ "pods" ]; verbs = [ "get" "list" "watch" "patch" "delete" ]; }
          { apiGroups = [ "coordination.k8s.io" ]; resources = [ "leases" ]; verbs = [ "get" "list" "watch" "create" "update" ]; }
          # The orphan reaper deletes the Sandbox CR and the provisioner-created SA
          # and ConfigMap.
          { apiGroups = [ "agents.x-k8s.io" ]; resources = [ "sandboxes" ]; verbs = [ "get" "list" "watch" "delete" "patch" ]; }
          { apiGroups = [ "" ]; resources = [ "serviceaccounts" "configmaps" ]; verbs = [ "get" "list" "delete" ]; }
          # Overlay-store retention.
          { apiGroups = [ "" ]; resources = [ "persistentvolumeclaims" ]; verbs = [ "list" "delete" ]; }
          # The autoscaler patches the agent-host Deployment's scale subresource.
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
                  # The leader-election Lease holder identity.
                  { name = "POD_NAME"; valueFrom.fieldRef.fieldPath = "metadata.name"; }
                  # Orphaned-Sandbox reaper (leader-only).
                  { name = "REAP_ORPHANED_SANDBOXES"; value = if ccfg.reapOrphans then "1" else "0"; }
                  { name = "ORPHAN_GRACE_SECONDS"; value = toString ccfg.orphanGraceSeconds; }
                  { name = "OVERLAY_RETENTION_SECONDS"; value = toString ccfg.overlayRetentionSeconds; }
                  # Agent-host autoscaler (leader-only, single writer of agent-host replicas).
                  { name = "AUTOSCALE_AGENT_HOST"; value = if ccfg.autoscale then "1" else "0"; }
                  { name = "AGENT_HOST_MIN_REPLICAS"; value = toString ccfg.minReplicas; }
                  { name = "AGENT_HOST_MAX_REPLICAS"; value = toString ccfg.maxReplicas; }
                  { name = "SCALE_DOWN_COOLDOWN_SECONDS"; value = toString ccfg.scaleDownCooldownSeconds; }
                  { name = "METRICS_PORT"; value = toString ccfg.metricsPort; }
                  # Write handle on agent_host.conversations for mirroring `phase` onto
                  # the row, via the controller's own role.
                  { name = "AGENT_HOST_DB_HOST"; value = cfg.postgres.host; }
                  { name = "AGENT_HOST_DB_PORT"; value = toString cfg.postgres.port; }
                  { name = "AGENT_HOST_DB_NAME"; value = "agent_host"; }
                  { name = "AGENT_HOST_DB_USER"; value = "conversation_controller"; }
                  { name = "AGENT_HOST_DB_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-conversation-controller"; key = "password"; }; }
                ]
                ++ lib.optional (cfg.postgres.sslmode != null) { name = "AGENT_HOST_DB_SSLMODE"; value = cfg.postgres.sslmode; }
                ++ cfg.contribDbEnv.conversation-controller;
                ports = [{ name = "metrics"; containerPort = ccfg.metricsPort; }];
                # requests == limits so the leader is never an eviction candidate.
                resources = lib.mkDefault {
                  requests = { cpu = "25m"; memory = "256Mi"; };
                  limits = { cpu = "25m"; memory = "256Mi"; };
                };
              };
            };
          };
        };
      };

      # --- the ROUTER: SA + RBAC (watch agent-host pods) + Deployment ----
      serviceAccounts.conversation-router.metadata = {
        name = "conversation-router";
        namespace = cfg.namespace;
      };
      roles.conversation-router = {
        metadata = { name = "conversation-router"; namespace = cfg.namespace; };
        rules = [
          # Ready agent-host pods, to resolve an assigned pod name.
          { apiGroups = [ "" ]; resources = [ "pods" ]; verbs = [ "get" "list" "watch" ]; }
        ];
      };
      roleBindings.conversation-router = {
        metadata = { name = "conversation-router"; namespace = cfg.namespace; };
        roleRef = { apiGroup = "rbac.authorization.k8s.io"; kind = "Role"; name = "conversation-router"; };
        subjects = [{ kind = "ServiceAccount"; name = "conversation-router"; namespace = cfg.namespace; }];
      };

      # Cluster-scoped TokenReview grant for verifying the webhooks/scheduler SA
      # token before honoring a body `owner`.
      clusterRoles.conversation-router-tokenreview = {
        metadata.name = "conversation-router-tokenreview";
        rules = [{
          apiGroups = [ "authentication.k8s.io" ];
          resources = [ "tokenreviews" ];
          verbs = [ "create" ];
        }];
      };

      clusterRoleBindings.conversation-router-tokenreview = {
        metadata.name = "conversation-router-tokenreview";
        roleRef = {
          apiGroup = "rbac.authorization.k8s.io";
          kind = "ClusterRole";
          name = "conversation-router-tokenreview";
        };
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
                ports = builtins.seq routerPorts [{ containerPort = 8080; name = "agui"; }]
                  ++ lib.optional ccfg.selfAccess.enable { containerPort = ccfg.selfAccess.port; name = "self"; }
                  # The sandbox-host listener: the only port the public wildcard Ingress reaches.
                  ++ lib.optional (cfg.ingress.sandboxDomain != "") { containerPort = sandboxPort; name = "sandbox"; };
                env = [
                  { name = "NAMESPACE"; value = cfg.namespace; }
                  # The fallback Service for unassigned requests must select the
                  # agent-host pods, not the `agent-host` Service that fronts the router.
                  { name = "AGENT_HOST_SERVICE"; value = "agent-host-pods"; }
                  { name = "UPSTREAM_PORT"; value = "8080"; }
                  { name = "LISTEN_ADDR"; value = ":8080"; }
                  # Requests to <label>.<sandboxDomain> are a conversation's web services,
                  # served only on SANDBOX_LISTEN_ADDR; the main listener refuses those hosts.
                  { name = "SANDBOX_DOMAIN"; value = cfg.ingress.sandboxDomain; }
                  { name = "SANDBOX_LISTEN_ADDR"; value = ":${toString sandboxPort}"; }
                  # Read-only handle on the agent_host database via the router's own role.
                  { name = "AGENT_HOST_DB_HOST"; value = cfg.postgres.host; }
                  { name = "AGENT_HOST_DB_PORT"; value = toString cfg.postgres.port; }
                  { name = "AGENT_HOST_DB_NAME"; value = "agent_host"; }
                  { name = "AGENT_HOST_DB_USER"; value = "conversation_router"; }
                  { name = "AGENT_HOST_DB_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-conversation-router"; key = "password"; }; }
                ]
                ++ lib.optional (cfg.postgres.sslmode != null) { name = "AGENT_HOST_DB_SSLMODE"; value = cfg.postgres.sslmode; }
                # Read-only handle on the webhooks database for link enrichment.
                ++ lib.optionals cfg.webhooks.enable [
                  { name = "WEBHOOKS_DB_HOST"; value = cfg.postgres.host; }
                  { name = "WEBHOOKS_DB_PORT"; value = toString cfg.postgres.port; }
                  { name = "WEBHOOKS_DB_NAME"; value = "webhooks"; }
                  { name = "WEBHOOKS_DB_USER"; value = "conversation_router"; }
                  { name = "WEBHOOKS_DB_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-conversation-router"; key = "password"; }; }
                ]
                ++ lib.optional (cfg.webhooks.enable && cfg.postgres.sslmode != null) { name = "WEBHOOKS_DB_SSLMODE"; value = cfg.postgres.sslmode; }
                ++ cfg.contribDbEnv.conversation-router
                # The router must read identity exactly as the agent-host does.
                ++ lib.optional (cfg.auth.mode != "header")
                  { name = "AUTH_MODE"; value = cfg.auth.mode; }
                ++ lib.optional (cfg.auth.userHeader != "x-auth-user")
                  { name = "AUTH_USER_HEADER"; value = cfg.auth.userHeader; }
                ++ lib.optional (cfg.auth.emailHeader != "x-auth-email")
                  { name = "AUTH_EMAIL_HEADER"; value = cfg.auth.emailHeader; }
                ++ lib.optional cfg.auth.enforce
                  { name = "AUTH_ENFORCE"; value = enforceAuth; }
                ++ [
                  # The SA(s) the router trusts as in-cluster callers.
                  { name = "WEBHOOKS_SERVICE_ACCOUNT";
                    value = lib.concatStringsSep "," (
                      [ "system:serviceaccount:${cfg.namespace}:agent-webhooks"
                        "system:serviceaccount:${cfg.namespace}:agent-host" ]
                      ++ lib.optional cfg.scheduler.enable "system:serviceaccount:${cfg.namespace}:agent-scheduler"
                    ); }
                  # The audience the callers' projected tokens are minted for.
                  { name = "WEBHOOKS_TOKEN_AUDIENCE"; value = "agent-host"; }
                  # The gateway's own audience; `agent-host` is still accepted meanwhile.
                  { name = "ROUTER_TOKEN_AUDIENCE"; value = "scooter-router"; }
                ]
                # Services that may call the router without asserting a user.
                ++ lib.optional cfg.broker.enable
                  { name = "ROUTER_SERVICE_ACCOUNTS"; value = "system:serviceaccount:${cfg.namespace}:agent-broker"; }
                ++ lib.optionals (ccfg.spawners != [ ]) [
                  { name = "CONVERSATION_SPAWNER_SERVICE_ACCOUNTS";
                    value = lib.concatMapStringsSep "," (sa: "system:serviceaccount:${cfg.namespace}:${sa}") ccfg.spawners; }
                  { name = "SPAWNS_PER_SOURCE_PER_HOUR"; value = toString ccfg.spawnsPerSourcePerHour; }
                ]
                ++ lib.optional (cfg.auth.sessionCheckUrl != null)
                  { name = "AUTH_SESSION_CHECK_URL"; value = cfg.auth.sessionCheckUrl; }
                ++ lib.optional (cfg.auth.sandboxSessionCheckUrl != null)
                  { name = "AUTH_SANDBOX_SESSION_CHECK_URL"; value = cfg.auth.sandboxSessionCheckUrl; }
                ++ lib.optional (cfg.auth.albRegion != null)
                  { name = "AUTH_ALB_REGION"; value = cfg.auth.albRegion; }
                ++ lib.optional (cfg.auth.sessionCookies != [ "_oauth2_proxy" "AWSELBAuthSessionCookie" ])
                  { name = "AUTH_SESSION_COOKIES"; value = lib.concatStringsSep "," cfg.auth.sessionCookies; }
                ++ lib.optionals ccfg.selfAccess.enable [
                  { name = "SELF_LISTEN_ADDR"; value = ":${toString ccfg.selfAccess.port}"; }
                  { name = "SELF_TOKEN_AUDIENCE"; value = ccfg.selfAccess.audience; }
                  { name = "SELF_MESSAGES_PER_MINUTE"; value = toString ccfg.selfAccess.messagesPerMinute; }
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
  })
  (lib.mkIf ccfg.selfAccess.enable {
    # Separate from the `agent-host` front door so a NetworkPolicy can admit sandboxes here only.
    kubernetes.resources.services.conversation-router-self = {
      metadata = { name = "conversation-router-self"; namespace = cfg.namespace; };
      spec = {
        selector.app = "conversation-router";
        ports = [{ port = 8080; targetPort = "self"; name = "self"; }];
      };
    };
    scooter.deployTools.tokenAudiences = [ ccfg.selfAccess.audience ];
    scooter.deployTools.env = {
      SCOOTER_SELF_URL = "http://conversation-router-self.${cfg.namespace}.svc.cluster.local:8080";
      SCOOTER_SELF_TOKEN_PATH = "/var/run/secrets/${ccfg.selfAccess.audience}/token";
    };
  })
  ];
}
