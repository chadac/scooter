# Broker tools — the credential-broker CLIs the agent's exec'd commands use in the
# sandbox (broker whoami, brokered git clone). These are ALWAYS needed, so they're
# prebuilt on the sandbox image (not lazy stubs).
#
# Exposed as an overlay (overlays.brokerTools -> pkgs.scooterBrokerTools) so any
# evaluation of the sandbox config can pull them in. The shell sources live HERE
# (one source of truth).
#
# The AWS CLIs used to live here too, embedding services/broker/…/aws/cli.py. They
# are contrib/aws/sandbox.nix's now: a tool only aws needs belongs to aws, not to
# every sandbox. Why: #599.
#
# Previously these lived in pkgs/sandbox-image (the retired legacy image); they
# moved here so that image could be deleted while keeping the tools.

{ pkgs }:

let
  # agent-broker: thin curl wrapper for calling the credential broker with the
  # pod's projected SA token (so `agent-broker test/whoami` Just Works).
  agent-broker = pkgs.writeShellApplication {
    name = "agent-broker";
    runtimeInputs = [ pkgs.curl pkgs.jq pkgs.coreutils ];
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
in
{
  inherit agent-broker git-credential-broker;

  # Both as a single list, for `environment.systemPackages = scooterBrokerTools.all`.
  all = [ agent-broker git-credential-broker ];
}
