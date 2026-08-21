# BYOC controller — Deployment + Service + (optional) UNAUTHENTICATED Ingress.
#
# Holds the bring-your-own-Claude container sockets so ANY agent-host replica can drive ANY
# container (todo/docs/BYO_CLAUDE_REMOTE_AGENT.md §L). The user's container dials
# wss://<host>/byoc/ws/<session-id>; agent-hosts reach the controller in-cluster over plain HTTP.
#
# THE INGRESS IS DELIBERATELY UNAUTHENTICATED (§L Q3), for the same reason webhooks' is: the
# client cannot carry a browser session. A webhook provider signs with an HMAC; a BYOC container
# presents a short-lived, owner-bound HS256 join token whose audience is `byoc`. Do NOT attach an
# auth middleware here — the container would be rejected before the token check ever runs.
#
# Note what is NOT exposed on this ingress: the MINT endpoint (POST /byoc/sessions) requires a
# resolved user and is served from the authed UI surface. Only /byoc/ws/ needs to be public.
#
# SINGLE REPLICA (§L decision 3). One process owns every container socket, so there is no
# cross-replica socket problem. Do not scale this without revisiting §L — multi-replica
# reintroduces exactly the "which pod holds the socket" bug the design exists to delete. The
# replica count is therefore NOT an option.

{ config, lib, ... }:

let
  cfg = config.agentSandbox;
  bcfg = cfg.byoc;
in
{
  options.agentSandbox.byoc = with lib; {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Deploy the BYOC (bring-your-own-Claude) controller.";
    };
    image = mkOption {
      type = types.str;
      default = "${cfg.registryPrefix}byoc-controller:latest";
      defaultText = literalExpression ''"''${registryPrefix}byoc-controller:latest"'';
      description = "OCI ref of the BYOC controller image.";
    };
    joinSecretName = mkOption {
      type = types.str;
      default = "agent-byoc-join";
      description = ''
        Secret holding key `secret` — the HMAC key for join tokens. The agent-host mints with the
        SAME key, so both must reference this secret.
      '';
    };
    ingress = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Expose /byoc/ via a standard Ingress so a user's container can dial in.";
      };
      host = mkOption {
        type = types.str;
        default = "";
        example = "scooter.example.com";
        description = "Public hostname for the BYOC connect path (/byoc).";
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

  config = lib.mkIf bcfg.enable {
    kubernetes.resources = lib.mkMerge [
      {
        deployments.byoc-controller = {
          metadata = {
            name = "byoc-controller";
            namespace = cfg.namespace;
            labels."app.kubernetes.io/name" = "byoc-controller";
          };
          spec = {
            # ONE replica, on purpose — see the header. A rollout drops the sockets and every
            # container reconnects on its own (`--restart always` + jittered backoff).
            replicas = 1;
            # Recreate, not RollingUpdate: two replicas overlapping would each hold a subset of the
            # container sockets, which is precisely the state §L exists to make impossible.
            strategy.type = "Recreate";
            selector.matchLabels."app.kubernetes.io/name" = "byoc-controller";
            template = {
              metadata.labels."app.kubernetes.io/name" = "byoc-controller";
              spec = {
                containers.byoc-controller = {
                  image = bcfg.image;
                  imagePullPolicy = "IfNotPresent";
                  ports = [{ name = "http"; containerPort = 8080; }];
                  env = [
                    { name = "PORT"; value = "8080"; }
                    {
                      name = "BYOC_JOIN_SECRET";
                      valueFrom.secretKeyRef = { name = bcfg.joinSecretName; key = "secret"; };
                    }
                    # Durable owner->session mapping + the device registry (§L Q4 / §P). The
                    # platform's postgres-init provisions a `byoc` db + role and writes ONLY a
                    # `password` key (no assembled DSN) — so the parts come in separately and the
                    # app builds the DSN, matching webhooks/broker/scheduler. Asking for a `dsn`
                    # key here is what left the pod in CreateContainerConfigError.
                    { name = "DB_HOST"; value = cfg.postgres.host; }
                    { name = "DB_PORT"; value = toString cfg.postgres.port; }
                    { name = "DB_NAME"; value = "byoc"; }
                    { name = "DB_USER"; value = "byoc"; }
                    {
                      name = "DB_PASSWORD";
                      valueFrom.secretKeyRef = { name = "agent-pg-byoc"; key = "password"; };
                    }
                  ];
                  readinessProbe.httpGet = { path = "/healthz"; port = "http"; };
                  livenessProbe.httpGet = { path = "/healthz"; port = "http"; };
                };
              };
            };
          };
        };

        services.byoc-controller = {
          metadata = { name = "byoc-controller"; namespace = cfg.namespace; };
          spec = {
            selector."app.kubernetes.io/name" = "byoc-controller";
            ports = [{ name = "http"; port = 8080; targetPort = "http"; }];
          };
        };
      }

      (lib.mkIf bcfg.ingress.enable {
        # UNAUTHENTICATED by design (§L Q3) — see the header. Only the /byoc/ws/ connect path needs
        # to be public; minting stays on the authed UI surface.
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
              http.paths = [{
                path = "/byoc";
                pathType = "Prefix";
                backend.service = { name = "byoc-controller"; port.number = 8080; };
              }];
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

    # Register with the shared Postgres: the provisioning Job creates the `byoc` database + role
    # (secret agent-pg-byoc, referenced above).
    agentSandbox.postgres.consumers.byoc = { db = "byoc"; user = "byoc"; };
  };
}
