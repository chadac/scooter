# aws's deployment half, reading contribs.aws.
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
  # The table declaration is gated on the contrib being built rather than on this
  # deployment running it, since `just db-generate` renders from bare defaults.
  config = lib.mkMerge [
    (lib.mkIf ccfg.enable {
      # LEGACY: the table now lives in contrib_aws (contrib.nix `db`). The broker copy
      # stays declared while any deployment still has it (until every one has set
      # scooter.dbMigrate.retireCopiedTables); then this row and `copyFrom` go together.
      scooter.db.broker.tables.permission_requests = { writers = [ "broker" ]; };
    })

    # Everything else is a deployment property, gated on the broker being deployed
    # as well as aws.
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
          # The provider notifies the agent-host to raise the approval interrupt, at
          # the platform's one cluster-internal agent-host URL.
          { name = "AWS_AGENT_HOST_URL"; value = bcfg.agentHostUrl; }
        ];

        # The registry is a mounted file, so this hash is what makes an account edit roll the pod.
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

      # Where the agent-host relays a human's Approve/Deny; pendingPath lets the requests survive a rollout.
      scooter.approvals.aws = {
        brokerPrefix = "/aws/aws";
        pendingPath = "/aws/aws/pending";
      };

      # The sandbox's half of the same registry, from which contrib/aws/sandbox.nix renders ~/.aws/config.
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

      # The account registry, mounted in the broker and in every sandbox.
      kubernetes.resources.configMaps.agent-broker-aws-accounts = {
        metadata = { name = "agent-broker-aws-accounts"; namespace = cfg.namespace; };
        data."accounts.json" = builtins.toJSON ccfg.accounts;
      };
    })
  ];
}
