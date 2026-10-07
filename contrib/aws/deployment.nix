# aws's DEPLOYMENT half: the manifests it renders, off contribs.aws. Why: #599.
#
# `{ config, lib, ... }` only, and nothing built: an external deployer imports
# modules/platform.nix with no `pkgs`, so forcing a package here is an eval error.
{ config, lib, ... }:

let
  cfg = config.scooter;
  bcfg = cfg.broker;
  ccfg = config.contribs.aws;
in
{
  # The table declaration is gated on the contrib being BUILT, never on this
  # deployment running it — `just db-generate` renders from bare defaults, so a
  # deployment-gated table vanishes from the committed schema. Why: PR #637.
  config = lib.mkMerge [
    (lib.mkIf ccfg.enable {
      # Writer is `broker`: the contrib runs inside the broker image and writes
      # through the broker's own database role. It declares no `owner` — that is
      # modules/broker.nix's, which owns the database.
      scooter.db.broker.tables.permission_requests = { writers = [ "broker" ]; };
    })

    # Everything else IS a deployment property, and gated on the BROKER being
    # deployed as well as aws: without the broker there is no container to inject env
    # into, and the ConfigMap below would render for a deployment that runs no broker.
    (lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
      scooter.broker = {
        extraEnv = [
          { name = "AWS_ENABLED"; value = "true"; }
          { name = "AWS_REGION"; value = ccfg.region; }
          { name = "AWS_STS_EXTERNAL_ID"; value = ccfg.externalId; }
          { name = "AWS_BROKER_PRINCIPAL_ARN"; value = ccfg.brokerPrincipalArn; }
          { name = "AWS_ACCOUNTS_FILE"; value = "/etc/agent-broker/accounts.json"; }
          { name = "AWS_ROLE_TTL_HOURS"; value = toString ccfg.roleTtlHours; }
          { name = "AWS_APPROVER_CLAIM"; value = ccfg.approverClaim; }
          # The provider notifies the agent-host to raise the approval interrupt. The
          # platform's one cluster-internal agent-host URL, not a second knob that
          # could be set to disagree with core's AGENT_HOST_URL.
          { name = "AWS_AGENT_HOST_URL"; value = bcfg.agentHostUrl; }
        ];

        # The registry is a mounted FILE, so its content is invisible to the pod
        # template — without this hash, editing an account updates the file in place
        # and the already-running process keeps serving the accounts it read at
        # startup, with no rollout and nothing logged.
        podAnnotations."checksum/aws-accounts" =
          builtins.hashString "sha256" (builtins.toJSON ccfg.accounts);

        # IRSA: the broker pod assumes each account's base role via this role.
        serviceAccountAnnotations = lib.optionalAttrs (ccfg.serviceAccountRoleArn != "") {
          "eks.amazonaws.com/role-arn" = ccfg.serviceAccountRoleArn;
        };

        extraVolumeMounts = [
          { name = "aws-accounts"; mountPath = "/etc/agent-broker"; readOnly = true; }
        ];
        extraVolumes = [
          { name = "aws-accounts"; configMap.name = "agent-broker-aws-accounts"; }
        ];
      };

      # Where the agent-host relays a human's Approve/Deny. Inside this `mkIf`, so a
      # deployment that does not run aws never points the relay at routes its broker
      # has not mounted. pendingPath is set because these requests MUST survive a
      # rollout: the agent is blocked on the answer, and an approval window that
      # vanishes leaves a user who cannot act and an agent that never proceeds.
      scooter.approvals.aws = {
        brokerPrefix = "/aws/aws";
        pendingPath = "/aws/aws/pending";
      };

      # The SANDBOX's half of the same registry: contrib/aws/sandbox.nix renders
      # ~/.aws/config from this file (one [profile <name>] per account). Reaches
      # every sandbox through modules/sandbox-pod.nix, so neither the Nix mirror
      # (modules/conversation.nix) nor the agent-host provisioner spells aws.
      scooter.sandboxPod = {
        extraVolumeMounts = [
          { name = "aws-accounts"; mountPath = "/etc/agent-sandbox/aws"; readOnly = true; }
        ];
        extraVolumes = [
          { name = "aws-accounts"; configMap.name = "agent-broker-aws-accounts"; }
        ];
        extraEnv = [
          { name = "AWS_ACCOUNTS_FILE"; value = "/etc/agent-sandbox/aws/accounts.json"; }
        ];
      };

      # The account registry, mounted at /etc/agent-broker/accounts.json. Single
      # source of truth shared with the sandbox's ~/.aws/config profiles, which read
      # the same ConfigMap through a second mount (see contrib/aws/sandbox.nix).
      kubernetes.resources.configMaps.agent-broker-aws-accounts = {
        metadata = { name = "agent-broker-aws-accounts"; namespace = cfg.namespace; };
        data."accounts.json" = builtins.toJSON ccfg.accounts;
      };
    })
  ];
}
