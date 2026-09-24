# Carry-over from the legacy pkgs/sandbox-image: the broker tooling + the boot
# steps its entrypoint.sh performed, ported to the NixOS dev-environment image so
# the agent-host's exec'd commands work unchanged (broker whoami, brokered git
# clone).
#
# What moves where:
#   - the broker tools (agent-broker, git-credential-broker) -> packages on PATH
#     (same scripts, ONE source of truth — read verbatim from pkgs/broker-tools, so
#     they can't drift);
#   - `git config --global credential.helper broker`  (entrypoint configure_git_broker)
#     -> a oneshot systemd service at boot.
# The pod env/volumes (HOME, BROKER_URL, BROKER_TOKEN_PATH, the broker token mount)
# are still set by the provisioner — these units just consume them, exactly as the
# old entrypoint did.
#
# The aws third of this file — the scooter-aws CLIs, the awscli2 stub and the
# ~/.aws/config render — is contrib/aws/sandbox.nix now. It still reads `home`
# below, which is the one place that path is declared. Why: #599.
#
# The writable Nix store the old entrypoint faked with an overlay is NATIVE here
# (NixOS has a real store), so that job is dropped.

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.scooterCarryOver;

  # The broker tools come from the prebuilt broker-tools package (a single source
  # of truth, pkgs/broker-tools — no readFile drift). callPackage'd directly (not
  # via nixpkgs.overlays, which conflicts with the nixosTest framework's own
  # nixpkgs.pkgs). The relative path resolves in the in-pod runtime-converge build
  # too (the modulesTree vendors pkgs/broker-tools at the same layout).
  brokerTools = pkgs.callPackage ../../pkgs/broker-tools { };
in
{
  options.programs.scooterCarryOver = {
    enable = lib.mkEnableOption "the broker/git carry-over from the legacy sandbox image";

    # The agent-host execs commands with HOME pinned to the writable workspace
    # (see k8sProvisioner). systemd PID 1 resets its OWN HOME to /root, so the
    # boot-time config units can't read the container's HOME from PID 1's environ
    # — they target this path directly so they write where the agent's git/aws
    # will actually read. Declared here and read by contrib/aws/sandbox.nix too,
    # so the git and aws renders cannot disagree about where the agent's HOME is.
    home = lib.mkOption {
      type = lib.types.str;
      default = "/workspace";
      description = "The HOME the agent-host execs with — where git/aws config is written.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = brokerTools.all ++ [ pkgs.git ];

    # configure_git_broker: point git's credential helper at the broker, once the
    # broker URL is known. Writes $HOME/.gitconfig (HOME = /workspace, set by the
    # provisioner). Best-effort, like the old entrypoint.
    systemd.services.scooter-git-broker = {
      description = "Configure git credential helper -> broker";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      # BROKER_URL comes from the container env; systemd PID 1 keeps it in its
      # environ (only HOME is reset), so we read it from there. We write the
      # gitconfig to the AGENT's HOME (cfg.home) explicitly via --file, since
      # --global would target systemd's HOME=/root, not where the agent reads.
      script = ''
        broker_url=$(tr '\0' '\n' < /proc/1/environ | sed -n 's/^BROKER_URL=//p' | head -1 || true)
        if [ -n "$broker_url" ]; then
          mkdir -p ${lib.escapeShellArg cfg.home}
          ${pkgs.git}/bin/git config --file ${lib.escapeShellArg "${cfg.home}/.gitconfig"} credential.helper broker || true
          echo "git credential helper -> broker ($broker_url) in ${cfg.home}/.gitconfig"
        fi
      '';
    };
  };
}
