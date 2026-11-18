# What aws is; its deployment half is ./deployment.nix and its sandbox half ./sandbox.nix.
{ lib, ... }:

let
  inherit (lib) mkOption types;
in
{
  contribs.aws = {
    imports = [ ./lib/rules.nix ];

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
    };

    config = {
      src = ./.;

      # Its own database (contrib_aws), so its Atlas history in ./sql is its own.
      # copyFrom moves the rows out of `broker` once. A deployment with
      # scooter.dbMigrate.retireCopiedTables then drops the broker table; copyFrom
      # goes once every deployment has.
      db = {
        enable = true;
        tables.permission_requests.copyFrom = "broker";
        tables.aws_request_approvals = { };
      };

      # The broker service half.
      services.broker = {
        enable = true;
        # boto3 for the IAM/STS calls.
        pythonDeps = ps: [ ps.boto3 ];
      };

      sandbox.module = ./sandbox.nix;
      skills."scooter-aws.md" = ./skills/scooter-aws.md;

      # A grant needs a human to say yes; only the UI half is here, with the defaults
      # being what aws wants, and the broker verbs are deployment config under
      # scooter.approvals in ./deployment.nix.
      approvals.grants = true;
      # Draws the grant's full policy instead of the plain Approve/Deny card.
      ui.interruptRenderers."aws.permissions".entry = "ui/PermissionsCard.tsx";
    };
  };
}
