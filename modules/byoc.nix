# BYOC controller: Deployment, Service and an optional unauthenticated Ingress.
# It holds the bring-your-own-Claude container sockets so any agent-host replica
# can drive any container; the user's container dials wss://<host>/byoc/ws/<id>
# and presents an owner-bound HS256 join token, so the ingress carries no auth
# middleware. The Ingress reaches only the "public" port, which serves just the
# container's routes; the "http" port serves the agent-host and is fenced to it
# by a NetworkPolicy. It runs a single replica because one process must own every socket.

{ config, lib, ... }:

let
  cfg = config.scooter;
  bcfg = cfg.byoc;
in
{
  options.scooter.byoc = with lib; {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Deploy the BYOC (bring-your-own-Claude) controller.";
    };
    image = mkOption {
      type = types.str;
      default = cfg.images.byoc-controller.pod.image;
      defaultText = literalExpression "config.scooter.images.byoc-controller.pod.image";
      description = "OCI ref of the BYOC controller image.";
    };
    traceTunnel = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Emit a per-frame trace of the MCP tunnel (`[tunnel.trace] …`): the JSON-RPC method,
        direction, byte counts and HTTP status of every stream, correlated by stream id.
        Off by default — per-frame logging is loud — but it shows the WHOLE exchange between
        the container's agent and the platform's MCP server in a single run, which is what
        debugging a two-process protocol actually requires.
      '';
    };
    joinSecretName = mkOption {
      type = types.str;
      default = cfg.agent.remoteAgent.joinSecret;
      defaultText = literalExpression "config.scooter.agent.remoteAgent.joinSecret";
      description = ''
        Secret holding key `secret` — the HMAC key for join tokens. The agent-host MINTS with the
        same key the controller VERIFIES with, so by default this is literally the same Secret as
        `agent.remoteAgent.joinSecret` — one name, one key, no way for the bytes to diverge.
        (Two separately-named secrets "that must hold the same bytes" was the previous shape, and
        it is exactly the kind of invariant a default should enforce rather than a comment.)
      '';
    };
    ingress = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = ''
          Expose the connect paths via a standard Ingress so a user's container can dial in. Default ON when
          the controller is enabled — a BYOC controller nothing can reach is not a configuration
          anyone wants; opt out for exotic topologies (own gateway, mesh).
        '';
      };
      host = mkOption {
        type = types.str;
        default = cfg.ingress.host;
        defaultText = literalExpression "config.scooter.ingress.host";
        example = "scooter.example.com";
        description = ''
          Public hostname for the BYOC connect paths (/byoc/ws/, /byoc/devices,
          /byoc/challenge). Defaults to the UI's own ingress host: this is a SEPARATE Ingress
          object carrying only those paths with NO auth annotations, so sharing the hostname
          does not weaken the authed UI ingress. Override for a dedicated hostname
          (e.g. byoc.example.com).
        '';
      };
      className = mkOption {
        type = types.str;
        default = "";
        example = "alb";
        description = "spec.ingressClassName (the controller). Empty = cluster default.";
      };
      annotations = mkOption {
        type = types.attrsOf types.str;
        default = { };
        description = ''
          Annotations on the BYOC Ingress — controller/cert config WITHOUT auth. The endpoint must
          accept an unauthenticated WebSocket upgrade from the user's container; the join token is
          the gate.
        '';
      };
      tls = mkOption {
        type = types.bool;
        default = true;
        description = "Add a spec.tls entry for `host`.";
      };
      tlsSecretName = mkOption {
        type = types.str;
        default = "";
        description = "TLS secret for the ingress host (empty = controller default).";
      };
    };
  };

  # The table declarations are unconditional (see modules/db-spec.nix); everything else is gated on `enable`.
  config = lib.mkMerge [

  # The tables the `byoc` database holds.
  {
    scooter.db.byoc = {
      owner = "byoc-controller";
      tables = {
        remote_agents = {
          writers = [ "byoc-controller" "agent-host" ];
          note = "byoc-controller owns session_id; agent-host writes the status/last_seen badge.";
        };
        remote_agent_devices = { writers = [ "byoc-controller" ]; };
      };
    };
  }
  (lib.mkIf bcfg.enable {
    kubernetes.resources = lib.mkMerge [
      {
        deployments.byoc-controller = {
          metadata = {
            name = "byoc-controller";
            namespace = cfg.namespace;
            labels."app.kubernetes.io/name" = "byoc-controller";
          };
          spec = {
            # A rollout drops the sockets and every container reconnects on its own.
            replicas = 1;
            # Overlapping replicas would each hold a subset of the container sockets.
            strategy.type = "Recreate";
            selector.matchLabels."app.kubernetes.io/name" = "byoc-controller";
            template = cfg.imageless.wrapPod "byoc-controller" "byoc-controller" {
              metadata.labels."app.kubernetes.io/name" = "byoc-controller";
              spec = {
                # Starts only once agent-db-migrate has applied this release.
                initContainers = cfg.schemaGate.initContainers.byoc or [ ];
                containers.byoc-controller = {
                  image = bcfg.image;
                  imagePullPolicy = "IfNotPresent";
                  ports = [
                    { name = "http"; containerPort = 8080; }
                    { name = "public"; containerPort = 8090; }
                  ];
                  env = [
                    { name = "PORT"; value = "8080"; }
                    { name = "PUBLIC_PORT"; value = "8090"; }
                    {
                      name = "BYOC_JOIN_SECRET";
                      valueFrom.secretKeyRef = { name = bcfg.joinSecretName; key = "secret"; };
                    }
                    # postgres-init writes only a `password` key, so the app assembles the DSN from these parts.
                    { name = "DB_HOST"; value = cfg.postgres.host; }
                    { name = "DB_PORT"; value = toString cfg.postgres.port; }
                    { name = "DB_NAME"; value = "byoc"; }
                    { name = "DB_USER"; value = "byoc"; }
                    {
                      name = "DB_PASSWORD";
                      valueFrom.secretKeyRef = { name = "agent-pg-byoc"; key = "password"; };
                    }
                    # Without this the controller silently connects cleartext to a Postgres the deployment asked to reach over TLS.
                  ] ++ lib.optional (cfg.postgres.sslmode != null)
                    { name = "DB_SSLMODE"; value = cfg.postgres.sslmode; };
                  # Probe the public port, which the NetworkPolicy leaves open.
                  readinessProbe.httpGet = { path = "/healthz"; port = "public"; };
                  livenessProbe.httpGet = { path = "/healthz"; port = "public"; };
                };
              };
            };
          };
        };

        services.byoc-controller = {
          metadata = { name = "byoc-controller"; namespace = cfg.namespace; };
          spec = {
            selector."app.kubernetes.io/name" = "byoc-controller";
            ports = [
              { name = "http"; port = 8080; targetPort = "http"; }
              { name = "public"; port = 8090; targetPort = "public"; }
            ];
          };
        };
      }

      (lib.mkIf bcfg.ingress.enable {
        # Unauthenticated by design, so it routes only the container's paths to the public port.
        ingresses.byoc-controller = {
          metadata = {
            name = "byoc-controller";
            namespace = cfg.namespace;
            annotations = bcfg.ingress.annotations;
          };
          spec = {
            ingressClassName = lib.mkIf (bcfg.ingress.className != "") bcfg.ingress.className;
            rules = [{
              host = bcfg.ingress.host;
              http.paths = map
                (p: p // { backend.service = { name = "byoc-controller"; port.name = "public"; }; })
                [
                  { path = "/byoc/ws"; pathType = "Prefix"; }
                  { path = "/byoc/devices"; pathType = "Exact"; }
                  { path = "/byoc/challenge"; pathType = "Exact"; }
                ];
            }];
            tls = lib.optionals bcfg.ingress.tls [
              ({ hosts = [ bcfg.ingress.host ]; }
                // lib.optionalAttrs (bcfg.ingress.tlsSecretName != "") {
                  secretName = bcfg.ingress.tlsSecretName;
                })
            ];
          };
        };
      })
    ];

    # The provisioning Job creates the `byoc` database and role (secret agent-pg-byoc).
    scooter.postgres.consumers.byoc = { db = "byoc"; user = "byoc"; };
  })
  ];
}
