# Broker tools — the credential-broker CLIs the agent's exec'd commands use in the
# sandbox (broker whoami, brokered git clone, AWS credential_process). These are
# ALWAYS needed, so they're prebuilt on the sandbox image (not lazy stubs).
#
# Exposed as an overlay (overlays.brokerTools -> pkgs.scooterBrokerTools) so any
# evaluation of the sandbox config can pull them in. The shell sources live HERE
# (one source of truth); the AWS CLIs embed the broker service's own cli.py so the
# in-sandbox helper can't drift from the broker.
#
# Previously these lived in pkgs/sandbox-image (the retired legacy image); they
# moved here so that image could be deleted while keeping the tools.

{ pkgs }:

let
  # agent-broker: thin curl wrapper for calling the credential broker with the
  # pod's projected SA token (so `agent-broker test/whoami` Just Works).
  agent-broker = pkgs.writeShellApplication {
    name = "agent-broker";
    runtimeInputs = [ pkgs.curl pkgs.coreutils ];
    text = builtins.readFile ./agent-broker.sh;
  };

  # git-credential-broker: git credential helper that vends HTTPS git creds from
  # the broker (per-request, short-lived). Name MUST be git-credential-broker so
  # `git config credential.helper broker` finds it on PATH.
  git-credential-broker = pkgs.writeShellApplication {
    name = "git-credential-broker";
    runtimeInputs = [ pkgs.curl pkgs.jq pkgs.coreutils ];
    text = builtins.readFile ./git-credential-broker.sh;
  };

  # The AWS request CLI + credential_process helper — the broker's own cli.py,
  # embedded verbatim (one source of truth with services/broker).
  scooterAwsCli = pkgs.writeTextFile {
    name = "scooter_aws_cli.py";
    destination = "/lib/scooter_aws_cli.py";
    text = builtins.readFile ../../services/broker/broker/aws/cli.py;
  };
  scooter-aws = pkgs.writeShellApplication {
    name = "scooter-aws";
    runtimeInputs = [ pkgs.python3 ];
    text = ''
      exec python3 -c 'import runpy,sys; m=runpy.run_path("${scooterAwsCli}/lib/scooter_aws_cli.py"); sys.exit(m["cli_main"](sys.argv[1:]))' "$@"
    '';
  };
  scooter-aws-credentials = pkgs.writeShellApplication {
    name = "scooter-aws-credentials";
    runtimeInputs = [ pkgs.python3 ];
    text = ''
      exec python3 -c 'import runpy,sys; m=runpy.run_path("${scooterAwsCli}/lib/scooter_aws_cli.py"); sys.exit(m["credentials_main"](sys.argv[1:]))' "$@"
    '';
  };
in
{
  inherit agent-broker git-credential-broker scooter-aws scooter-aws-credentials;

  # All four as a single list, for `environment.systemPackages = scooterBrokerTools.all`.
  all = [ agent-broker git-credential-broker scooter-aws scooter-aws-credentials ];
}
