# aws's DEPLOYMENT half: the option tree an operator configures, and the manifests
# it renders. Layered into modules/platform.nix by contrib/deployment-modules.nix.
#
# This was ~40 references in modules/broker.nix — the option tree, the AWS_* env
# block, the accounts ConfigMap, the rollout annotation and the IRSA annotation —
# which meant the platform module could not be read without reading one
# integration's IAM model. Nothing about it needed to be there: it reaches the
# broker Deployment through that module's seams (broker.extraEnv and friends) and
# renders its own ConfigMap straight into kubernetes.resources. Why: #599.
#
# `{ config, lib, ... }` only, and nothing built: an external deployer imports
# platform.nix with no `pkgs` (see contrib/deployment-modules.nix).
{ config, lib, ... }:

let
  inherit (lib) mkOption types literalExpression;
  cfg = config.agentSandbox;
  bcfg = cfg.broker;
  acfg = bcfg.aws;
in
{
  options.agentSandbox.broker.aws = {
    # Also THE GATE for this contrib's skills: platform.nix ships scooter-aws.md
    # only where this is true, because an agent taught to call /aws/* on a broker
    # that never mounted those routes reads the 404 as the feature being broken.
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Enable the AWS permissions provider (request/approve/provision dynamic IAM roles).";
    };
    region = mkOption { type = types.str; default = "us-east-1"; description = "AWS region."; };
    externalId = mkOption {
      type = types.str;
      default = "agent-permissions-broker";
      description = "STS ExternalId used when the broker assumes each account's base role.";
    };
    brokerPrincipalArn = mkOption {
      type = types.str;
      default = "";
      description = "The broker's IRSA role ARN — the principal the dynamic roles trust.";
    };
    serviceAccountRoleArn = mkOption {
      type = types.str;
      default = "";
      description = "IRSA role ARN annotated on the broker SA (eks.amazonaws.com/role-arn). Usually == brokerPrincipalArn.";
    };
    roleTtlHours = mkOption { type = types.int; default = 12; description = "Dynamic-role TTL (refresh window)."; };
    approverClaim = mkOption {
      type = types.enum [ "email" "id" "name" ];
      default = "email";
      description = ''
        Which identity claim authorizes an approver — must match how the FGA
        `approver` tuples are seeded (accounts.<a>.approvers, conventionally
        emails). The agent-host sends the answering user's {id, email, name}; the
        broker checks THIS claim. "email" (default) suits ALB-OIDC (where the id
        is an opaque sub); use "id" for header-auth that already carries emails.
      '';
    };
    accounts = mkOption {
      type = types.attrsOf (types.attrsOf types.anything);
      default = { };
      description = ''
        The account registry: alias -> { account_id, broker_role_arn, enabled,
        description?, allowed_policy?, allowed_managed_policies?, region?,
        approvers?, auto_approve_read_only?, auto_allowed_policy?,
        auto_allowed_managed_policies? }. Rendered into a ConfigMap mounted
        at /etc/agent-broker/accounts.json.

        `description` is a human-written summary of what the account is for. The
        agent reads it (via `scooter-aws accounts` → GET /aws/accounts) to pick
        the RIGHT account to request access to — set it on every account.

        Set `auto_approve_read_only = true` on an account to grant purely
        read-only requests (all actions Get*/List*/Describe*/… ; no managed-policy
        ARNs) immediately, WITHOUT a human approver — recorded as approved_by
        "system:auto-approve-read-only". Anything with a write action or a managed
        ARN still needs a human. Default off (every request needs approval).

        `auto_allowed_policy` (+ `auto_allowed_managed_policies`) is the general
        form: an OPT-IN glob superset of grants auto-approved with no human — same
        fnmatch shape as allowed_policy (Action+Resource statements; managed-ARN
        fnmatch patterns). e.g. pre-approve assuming deploy roles:
          auto_allowed_policy.Statement = [{
            Action = [ "sts:AssumeRole" ];
            Resource = [ "arn:aws:iam::123456789012:role/deploy-*" ];
          }];
        A request FULLY covered by it (every action+resource, every managed ARN)
        skips approval; anything in `allowed_policy` but NOT in the auto tier still
        needs a human. Checked AFTER the ceiling, so auto ⊆ allowed by construction.

        Per-account `approvers` are seeded into OpenFGA at startup when
        agentSandbox.broker.fga.enable is set — the authorization backend is
        substrate and lives there, not here (#595).

        Example:
          accounts.readonly-sandbox = {
            account_id = "123456789012";
            broker_role_arn = "arn:aws:iam::123456789012:role/agent-token-broker-base";
            enabled = true;
            description = "Sandbox account for safe read-only exploration (S3, logs).";
            auto_approve_read_only = true;
          };
      '';
      example = literalExpression ''
        {
          readonly-sandbox = {
            account_id = "123456789012";
            broker_role_arn = "arn:aws:iam::123456789012:role/agent-token-broker-base";
            enabled = true;
            auto_approve_read_only = true;
          };
        }
      '';
    };
  };

  # Gated on the BROKER being deployed too, not just on aws: without it there is no
  # container to inject env into, and the ConfigMap below would render for a
  # deployment that runs no broker at all.
  config = lib.mkIf (bcfg.enable && acfg.enable) {
    agentSandbox.broker = {
      extraEnv = [
        { name = "AWS_ENABLED"; value = "true"; }
        { name = "AWS_REGION"; value = acfg.region; }
        { name = "AWS_STS_EXTERNAL_ID"; value = acfg.externalId; }
        { name = "AWS_BROKER_PRINCIPAL_ARN"; value = acfg.brokerPrincipalArn; }
        { name = "AWS_ACCOUNTS_FILE"; value = "/etc/agent-broker/accounts.json"; }
        { name = "AWS_ROLE_TTL_HOURS"; value = toString acfg.roleTtlHours; }
        { name = "AWS_APPROVER_CLAIM"; value = acfg.approverClaim; }
        # The provider notifies the agent-host to raise the approval interrupt. The
        # platform's one cluster-internal agent-host URL, not a second knob that
        # could be set to disagree with core's AGENT_HOST_URL — which is what
        # `broker.aws.agentHostUrl` was, since the CORE auto-linking env read it.
        { name = "AWS_AGENT_HOST_URL"; value = bcfg.agentHostUrl; }
      ];

      # The registry is a mounted FILE, so its content is invisible to the pod
      # template — without this hash, editing an account updates the file in place
      # and the already-running process keeps serving the accounts it read at
      # startup, with no rollout and nothing logged.
      podAnnotations."checksum/aws-accounts" =
        builtins.hashString "sha256" (builtins.toJSON acfg.accounts);

      # IRSA: the broker pod assumes each account's base role via this role.
      serviceAccountAnnotations = lib.optionalAttrs (acfg.serviceAccountRoleArn != "") {
        "eks.amazonaws.com/role-arn" = acfg.serviceAccountRoleArn;
      };

      extraVolumeMounts = [
        { name = "aws-accounts"; mountPath = "/etc/agent-broker"; readOnly = true; }
      ];
      extraVolumes = [
        { name = "aws-accounts"; configMap.name = "agent-broker-aws-accounts"; }
      ];
    };

    # The account registry, mounted at /etc/agent-broker/accounts.json. Single
    # source of truth shared with the sandbox's ~/.aws/config profiles, which read
    # the same ConfigMap through a second mount (see contrib/aws/sandbox.nix).
    kubernetes.resources.configMaps.agent-broker-aws-accounts = {
      metadata = { name = "agent-broker-aws-accounts"; namespace = cfg.namespace; };
      data."accounts.json" = builtins.toJSON acfg.accounts;
    };
  };
}
