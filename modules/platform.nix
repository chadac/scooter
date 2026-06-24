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
  };

  config = {
    kubernetes.resources = {
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
                  { name = "IDLE_SUSPEND_MS"; value = toString cfg.idleSuspendMs; }
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
                volumeMounts = [{ name = "state"; mountPath = "/var/lib/agent-host"; }];
                readinessProbe.httpGet = { path = "/healthz"; port = "agui"; };
              };
              # Conversation-state PVC (Goose state + AG-UI event logs).
              volumes = [{ name = "state"; persistentVolumeClaim.claimName = "agent-host-state"; }];
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

      services.agent-host = {
        metadata = { name = "agent-host"; namespace = cfg.namespace; };
        spec = {
          selector.app = "agent-host";
          ports = [{ port = 8080; targetPort = "agui"; name = "agui"; }];
        };
      };
    };
  };
}
