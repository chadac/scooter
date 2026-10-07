# What aws IS. Deployment: ./deployment.nix. Sandbox: ./sandbox.nix.
{ lib, ... }:

let
  inherit (lib) mkOption types literalExpression;
in
{
  contribs.aws = {
    options = {
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
          scooter.broker.fga.enable is set — the authorization backend is
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

    config = {
      src = ./.;

      # Both halves live here now (#599). The service half needed two things a
      # contrib could not do when #617 moved the sandbox half: reach the authorizer
      # without constructing one (BrokerContext, #624) and read the shared broker DB
      # without reassembling it (StoreConfig on the surface, #622).
      services.broker = {
        enable = true;
        # boto3 came with the provider — it was in the broker app's closure solely
        # for this integration's IAM/STS calls.
        pythonDeps = ps: [ ps.boto3 ];
      };

      sandbox.module = ./sandbox.nix;
      skills."scooter-aws.md" = ./skills/scooter-aws.md;

      # A grant needs a human to say yes. Only the UI half is here (build-time metadata
      # for the contrib manifest); the defaults — grey "approve", "an admin must" — are
      # what aws wants, so the empty set is the declaration. Where its verbs live on the
      # broker is deployment config: see scooter.approvals in ./deployment.nix.
      approvals = { };
    };
  };
}
