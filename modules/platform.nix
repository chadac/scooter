# Platform manifests — the long-lived deployment of kubenix-agent-manager.
#
# Renders: namespace, the agent-host Deployment + Service, and the RBAC the
# agent-host needs to (a) provision per-conversation Sandboxes/SAs/PVCs and
# (b) exec into sandbox pods.
#
# The agent-sandbox controller + CRDs are installed separately (upstream release
# manifests); this module only deploys OUR platform on top.
#
# Per-conversation Sandboxes are created at runtime by the agent-host via the
# kube API (not here) — see modules/conversation.nix for that shape.

{ kubenix, config, lib, ... }:

let
  cfg = config.agentSandbox;
  # The ingress targets the UI when it's deployed (the UI proxies the API on the
  # same origin); otherwise it targets the agent-host API directly.
  ingressBackend = if cfg.ui.enable then "ui" else "agent-host";
in
{
  imports = [ kubenix.modules.k8s ./broker.nix ./webhooks.nix ];

  options.agentSandbox = with lib; {
    namespace = mkOption {
      type = types.str;
      default = "agent-sandbox";
      description = "Namespace for the platform + sandboxes.";
    };
    registryPrefix = mkOption {
      type = types.str;
      default = "";
      example = "123456789012.dkr.ecr.us-east-1.amazonaws.com/myorg/";
      description = ''
        Registry/repository prefix prepended to the default image names
        (agent-host, agent-broker, agent-webhooks, agent-sandbox-nix). Empty =
        bare local names (`agent-host:latest`) for kind/k3s where images are
        side-loaded. Set to an ECR/registry prefix (WITH trailing slash) for a
        real cluster. Per-image options below override this entirely.
      '';
    };
    pullPolicy = mkOption {
      type = types.enum [ "Always" "IfNotPresent" "Never" ];
      default = "IfNotPresent";
      description = ''
        imagePullPolicy for the platform Deployments. IfNotPresent suits
        side-loaded kind/k3s images; Always suits a registry-backed cluster.
      '';
    };
    agentHostImage = mkOption {
      type = types.str;
      default = "${cfg.registryPrefix}agent-host:latest";
      defaultText = literalExpression ''"''${registryPrefix}agent-host:latest"'';
      description = "OCI ref of the agent-host image.";
    };
    sandboxImage = mkOption {
      type = types.str;
      default = "${cfg.registryPrefix}agent-sandbox-nix:latest";
      defaultText = literalExpression ''"''${registryPrefix}agent-sandbox-nix:latest"'';
      description = "OCI ref of the generic Nix sandbox image.";
    };
    uiImage = mkOption {
      type = types.str;
      default = "${cfg.registryPrefix}agent-sandbox-ui:latest";
      defaultText = literalExpression ''"''${registryPrefix}agent-sandbox-ui:latest"'';
      description = "OCI ref of the UI image (nginx + static build + API proxy).";
    };
    ui.enable = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Deploy the conversation UI (nginx serving the assistant-ui build and
        proxying /agui + /sessions + the management API to the agent-host).
        When enabled, the ingress targets the UI (which proxies the API);
        when disabled, the ingress targets the agent-host directly.
      '';
    };
    replicas = mkOption {
      type = types.int;
      default = 1;
      description = "agent-host replicas (one host pod runs many goose sessions).";
    };
    fakeAgent = mkOption {
      type = types.bool;
      default = false;
      description = "Run the dummy ACP agent (GOOSE_BIN=fake) — for cluster e2e.";
    };

    serviceAccountRoleArn = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "arn:aws:iam::123456789012:role/agent-host";
      description = ''
        IRSA role ARN annotated onto the agent-host ServiceAccount
        (eks.amazonaws.com/role-arn). The role's trust policy must allow
        system:serviceaccount:<namespace>:agent-host. Used for Bedrock auth.
      '';
    };

    agent = {
      provider = mkOption {
        type = types.str;
        default = "aws_bedrock";
        description = "GOOSE_PROVIDER for the real agent (e.g. aws_bedrock, anthropic).";
      };
      model = mkOption {
        type = types.str;
        default = "us.anthropic.claude-opus-4-7";
        description = ''
          Default GOOSE_MODEL (the model used when a conversation doesn't pick
          one). For Bedrock, the cross-region inference-profile id.
        '';
      };
      availableModels = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = [ "us.anthropic.claude-opus-4-7" "us.anthropic.claude-sonnet-4-6" ];
        description = ''
          Models offered for per-conversation selection (AGENT_AVAILABLE_MODELS,
          comma-separated). The UI/management API lets a conversation override
          the default per-prompt. Empty = only the default model.
        '';
      };
      region = mkOption {
        type = types.str;
        default = "us-east-1";
        description = "AWS_REGION for the agent process (Bedrock region).";
      };
      name = mkOption {
        type = types.str;
        default = "Scooter";
        description = "Display name the agent goes by (AGENT_NAME) — its identity in the UI + prompt.";
      };
      skills = mkOption {
        type = types.attrsOf types.str;
        default = { };
        example = literalExpression ''
          {
            "project-repo.md" = '''
              ---
              name: project-repo
              ---
              The main repo is github.com/example-org/example-app. Clone it with
              `git clone https://github.com/example-org/example-app` to get started.
            ''';
          }
        '';
        description = ''
          Markdown skills injected into the agent as .goosehints (filename ->
          content). Rendered to a ConfigMap mounted at SKILLS_DIR on the
          agent-host and read per conversation — edit the ConfigMap to add/change
          a skill with no image rebuild. Filenames should end in .md.
        '';
      };
    };

    idleSuspendMs = mkOption {
      type = types.int;
      default = 30 * 60 * 1000;
      description = ''
        Idle window before the agent-host auto-suspends a conversation (drops
        the sandbox pod, keeps the PVCs). The agent-host owns the activity
        signal, so it self-manages lifecycle; activity metadata is still
        exposed via the management API for an external controller. 0 disables.
      '';
    };

    ingress = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Expose the agent-host (AG-UI/API + UI) via a Traefik IngressRoute.";
      };
      host = mkOption {
        type = types.str;
        default = "";
        example = "chat.example.com";
        description = "Public hostname. external-dns registers it from the route annotation.";
      };
      entryPoint = mkOption {
        type = types.str;
        default = "websecure";
        description = "Traefik entryPoint (websecure = auto-TLS via the cert resolver).";
      };
      middlewares = mkOption {
        type = types.listOf (types.submodule {
          options = {
            name = mkOption { type = types.str; };
            namespace = mkOption { type = types.str; };
          };
        });
        default = [ ];
        example = [{ name = "basic-auth"; namespace = "example-org"; }];
        description = "Traefik middlewares to attach (e.g. an existing basic-auth).";
      };
    };
  };

  config = {
    # mkMerge (not //): the optional UI / ingress blocks below ALSO define
    # `deployments` / `services`, and a shallow `//` update would replace the
    # whole `deployments` attrset (dropping agent-host). mkMerge deep-merges.
    kubernetes.resources = lib.mkMerge [
    {
      namespaces.${cfg.namespace} = {
        metadata.name = cfg.namespace;
      };

      serviceAccounts.agent-host = {
        metadata = {
          name = "agent-host";
          namespace = cfg.namespace;
        } // lib.optionalAttrs (cfg.serviceAccountRoleArn != null) {
          annotations."eks.amazonaws.com/role-arn" = cfg.serviceAccountRoleArn;
        };
      };

      # The agent-host provisions per-conversation Sandboxes/SAs/PVCs and execs
      # into sandbox pods, so it needs broad-but-namespaced RBAC.
      roles.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        rules = [
          {
            apiGroups = [ "agents.x-k8s.io" ];
            resources = [ "sandboxes" ];
            verbs = [ "get" "list" "watch" "create" "update" "patch" "delete" ];
          }
          {
            apiGroups = [ "" ];
            resources = [ "serviceaccounts" "persistentvolumeclaims" "pods" ];
            verbs = [ "get" "list" "watch" "create" "update" "patch" "delete" ];
          }
          {
            # Exec is how the ExecBackend runs the agent's commands in the pod.
            apiGroups = [ "" ];
            resources = [ "pods/exec" ];
            verbs = [ "create" ];
          }
        ];
      };

      roleBindings.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        roleRef = { apiGroup = "rbac.authorization.k8s.io"; kind = "Role"; name = "agent-host"; };
        subjects = [{ kind = "ServiceAccount"; name = "agent-host"; namespace = cfg.namespace; }];
      };

      deployments.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        spec = {
          replicas = cfg.replicas;
          selector.matchLabels.app = "agent-host";
          template = {
            metadata.labels.app = "agent-host";
            spec = {
              serviceAccountName = "agent-host";
              # The state PVC (EBS/ext4) is owned root:root with restrictive
              # access; the agent-host process can't write its per-conversation
              # dirs without an fsGroup that the kubelet uses to relabel/chgrp
              # the volume. 0 = root group (the uid the container runs as).
              securityContext = {
                fsGroup = 0;
                fsGroupChangePolicy = "OnRootMismatch";
              };
              containers.agent-host = {
                name = "agent-host";
                image = cfg.agentHostImage;
                imagePullPolicy = cfg.pullPolicy;
                ports = [{ containerPort = 8080; name = "agui"; }];
                env = [
                  { name = "PORT"; value = "8080"; }
                  { name = "NAMESPACE"; value = cfg.namespace; }
                  { name = "SANDBOX_IMAGE"; value = cfg.sandboxImage; }
                  { name = "STATE_PATH"; value = "/var/lib/agent-host/conversations"; }
                  # goose persists its sessions DB + config under $HOME; the image
                  # default ("/") is unwritable, which stalls `goose acp`'s
                  # session/new. Point it at the writable state volume.
                  { name = "HOME"; value = "/var/lib/agent-host/home"; }
                  { name = "IDLE_SUSPEND_MS"; value = toString cfg.idleSuspendMs; }
                  # Agent identity + skills: the agent-host writes these into the
                  # per-conversation .goosehints. SKILLS_DIR is the ConfigMap mount.
                  { name = "AGENT_NAME"; value = cfg.agent.name; }
                  { name = "SKILLS_DIR"; value = "/etc/agent-sandbox/skills"; }
                ] ++ lib.optionals (!cfg.fakeAgent) [
                  # Real `goose acp` on Bedrock (or another provider). The agent
                  # process inherits the pod's IRSA identity via the AWS SDK
                  # web-identity chain — no static keys.
                  { name = "GOOSE_PROVIDER"; value = cfg.agent.provider; }
                  { name = "GOOSE_MODEL"; value = cfg.agent.model; }
                  { name = "AWS_REGION"; value = cfg.agent.region; }
                  { name = "AWS_DEFAULT_REGION"; value = cfg.agent.region; }
                ] ++ lib.optional (!cfg.fakeAgent && cfg.agent.availableModels != [ ])
                  # Models offered for per-conversation selection (the management
                  # API/UI may override GOOSE_MODEL per conversation).
                  { name = "AGENT_AVAILABLE_MODELS"; value = lib.concatStringsSep "," cfg.agent.availableModels; }
                ++ lib.optional cfg.fakeAgent
                  # Run the bundled dummy ACP agent (no model/cluster) — for the
                  # spawn-from-webhook + UI e2e on the cluster.
                  { name = "GOOSE_BIN"; value = "fake"; };
                volumeMounts = [
                  { name = "state"; mountPath = "/var/lib/agent-host"; }
                  # The image's /tmp is read-only (nix store). goose needs a
                  # writable /tmp for session/new temp files — mount one.
                  { name = "tmp"; mountPath = "/tmp"; }
                ] ++ lib.optional (cfg.agent.skills != { })
                  # Skills ConfigMap -> read per conversation into .goosehints.
                  { name = "skills"; mountPath = "/etc/agent-sandbox/skills"; readOnly = true; };
                readinessProbe.httpGet = { path = "/healthz"; port = "agui"; };
              };
              # Conversation-state PVC (Goose state + AG-UI event logs) + writable /tmp.
              volumes = [
                { name = "state"; persistentVolumeClaim.claimName = "agent-host-state"; }
                { name = "tmp"; emptyDir = { }; }
              ] ++ lib.optional (cfg.agent.skills != { })
                { name = "skills"; configMap.name = "agent-skills"; };
            };
          };
        };
      };

      persistentVolumeClaims.agent-host-state = {
        metadata = { name = "agent-host-state"; namespace = cfg.namespace; };
        spec = {
          accessModes = [ "ReadWriteOnce" ];
          resources.requests.storage = "5Gi";
        };
      };

      # Agent skills (filename -> markdown), injected per conversation as
      # .goosehints. Edit this (the option) to add/change a skill — no image
      # rebuild. Only rendered when skills are configured.
      configMaps = lib.optionalAttrs (cfg.agent.skills != { }) {
        agent-skills = {
          metadata = { name = "agent-skills"; namespace = cfg.namespace; };
          data = cfg.agent.skills;
        };
      };

      services.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        spec = {
          selector.app = "agent-host";
          ports = [{ port = 8080; targetPort = "agui"; name = "agui"; }];
        };
      };
    }
    (lib.mkIf cfg.ui.enable {
      # Conversation UI — nginx serving the assistant-ui build and proxying the
      # agent-host API on the same origin (so the browser's /agui SSE + /sessions
      # + management calls work without CORS).
      deployments.ui = {
        metadata = { name = "ui"; namespace = cfg.namespace; };
        spec = {
          replicas = 1;
          selector.matchLabels.app = "ui";
          template = {
            metadata.labels.app = "ui";
            spec.containers.ui = {
              name = "ui";
              image = cfg.uiImage;
              imagePullPolicy = cfg.pullPolicy;
              ports = [{ containerPort = 8080; name = "http"; }];
              env = [{
                name = "AGENT_HOST_URL";
                value = "http://agent-host.${cfg.namespace}.svc.cluster.local:8080";
              }];
              readinessProbe.httpGet = { path = "/"; port = "http"; };
            };
          };
        };
      };

      services.ui = {
        metadata = { name = "ui"; namespace = cfg.namespace; };
        spec = {
          selector.app = "ui";
          ports = [{ port = 8080; targetPort = "http"; name = "http"; }];
        };
      };
    })
    (lib.mkIf cfg.ingress.enable {
      # DNS-only companion Ingress: external-dns runs --source=ingress (NOT the
      # Traefik IngressRoute CRD), so the standard Ingress is what registers the
      # hostname in Route53. The IngressRoute below does the actual routing +
      # TLS + auth. (Mirrors the openhands env-manager-dns pattern.)
      ingresses.agent-host-dns = {
        metadata = {
          name = "agent-host-dns";
          namespace = cfg.namespace;
          annotations = {
            "external-dns.alpha.kubernetes.io/hostname" = cfg.ingress.host;
          } // lib.optionalAttrs (cfg.ingress.middlewares != [ ]) {
            # This Ingress ALSO produces a Traefik router that serves traffic, so
            # it must carry the SAME middlewares as the IngressRoute — otherwise
            # it shadows the IngressRoute with an UNAUTHENTICATED route. Traefik
            # middleware refs here are "<namespace>-<name>@kubernetescrd".
            "traefik.ingress.kubernetes.io/router.middlewares" =
              lib.concatMapStringsSep ","
                (m: "${m.namespace}-${m.name}@kubernetescrd")
                cfg.ingress.middlewares;
          };
        };
        spec = {
          ingressClassName = "traefik";
          rules = [{
            host = cfg.ingress.host;
            http.paths = [{
              path = "/";
              pathType = "Prefix";
              backend.service = { name = ingressBackend; port.number = 8080; };
            }];
          }];
        };
      };
    })
    ];

    # Public ingress (opt-in). Traefik IngressRoute is a CRD, so it goes through
    # kubernetes.objects. external-dns reads the hostname annotation; websecure
    # terminates TLS via the cert resolver. Auth is whatever middlewares are
    # attached (e.g. reuse an existing basic-auth).
    kubernetes.objects = lib.optionals cfg.ingress.enable [
      {
        apiVersion = "traefik.io/v1alpha1";
        kind = "IngressRoute";
        metadata = {
          name = "agent-host";
          namespace = cfg.namespace;
          annotations."external-dns.alpha.kubernetes.io/hostname" = cfg.ingress.host;
        };
        spec = {
          entryPoints = [ cfg.ingress.entryPoint ];
          routes = [{
            kind = "Rule";
            match = "Host(`${cfg.ingress.host}`)";
            middlewares = map (m: { inherit (m) name namespace; }) cfg.ingress.middlewares;
            services = [{ name = ingressBackend; port = 8080; }];
          }];
        };
      }
    ];
  };
}
