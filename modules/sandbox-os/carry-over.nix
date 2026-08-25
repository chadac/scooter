# Carry-over from the legacy pkgs/sandbox-image: the broker tooling + the boot
# steps its entrypoint.sh performed, ported to the NixOS dev-environment image so
# the agent-host's exec'd commands work unchanged (broker whoami, brokered git
# clone, AWS credential_process).
#
# What moves where:
#   - the three broker tools (agent-broker, git-credential-broker, scooter-aws*)
#     -> packages on PATH (same scripts, ONE source of truth — read verbatim from
#        pkgs/sandbox-image + services/broker, so they can't drift);
#   - `git config --global credential.helper broker`  (entrypoint configure_git_broker)
#     -> a oneshot systemd service at boot;
#   - render ~/.aws/config from the accounts ConfigMap  (entrypoint configure_aws)
#     -> a oneshot systemd service at boot.
# The pod env/volumes (HOME, BROKER_URL, BROKER_TOKEN_PATH, AWS_ACCOUNTS_FILE, the
# broker token + aws-accounts mounts) are still set by the provisioner — these
# units just consume them, exactly as the old entrypoint did.
#
# The writable Nix store the old entrypoint faked with an overlay is NATIVE here
# (NixOS has a real store), so that job is dropped.

{ config, lib, pkgs, nixStubsLib ? null, ... }:

let
  cfg = config.programs.scooterCarryOver;

  # The broker tools come from the prebuilt broker-tools package (a single source
  # of truth, pkgs/broker-tools — no readFile drift). callPackage'd directly (not
  # via nixpkgs.overlays, which conflicts with the nixosTest framework's own
  # nixpkgs.pkgs). The relative path resolves in the in-pod runtime-converge build
  # too (the modulesTree vendors pkgs/broker-tools at the same layout).
  brokerTools = pkgs.callPackage ../../pkgs/broker-tools { };
  scooterAwsCredentials = brokerTools.scooter-aws-credentials;

  # awscli2 (+ its python) is ~280MB — too heavy to bake into the base image for a
  # tool most conversations never use. Ship it as a nix-stubs LAZY SHIM: only its
  # .drv is baked (tiny), and the built package materializes into the writable store
  # the first time the agent runs `aws` (fast against the baked nixpkgs / Attic
  # cache). The credential_process (scooter-aws-credentials, python) is unaffected —
  # it's a separate broker tool. Fall back to the real package when nix-stubs isn't
  # wired (the nixosTests import this module without the packaging layer).
  awscli =
    if nixStubsLib != null
    then nixStubsLib.mkLazyPackage { package = pkgs.awscli2; commands = [ "aws" "aws_completer" ]; }
    else pkgs.awscli2;
in
{
  options.programs.scooterCarryOver = {
    enable = lib.mkEnableOption "the broker/git/aws carry-over from the legacy sandbox image";

    # The agent-host execs commands with HOME pinned to the writable workspace
    # (see k8sProvisioner). systemd PID 1 resets its OWN HOME to /root, so the
    # boot-time config units can't read the container's HOME from PID 1's environ
    # — they target this path directly so they write where the agent's git/aws
    # will actually read.
    home = lib.mkOption {
      type = lib.types.str;
      default = "/workspace";
      description = "The HOME the agent-host execs with — where git/aws config is written.";
    };

    git = {
      userName = lib.mkOption {
        type = lib.types.str;
        default = "Scooter";
        description = "Default git user.name for all sandboxes in this deployment.";
      };

      userEmail = lib.mkOption {
        type = lib.types.str;
        default = "scooter@scooter.local";
        description = "Default git user.email for all sandboxes in this deployment.";
      };

      extraConfig = lib.mkOption {
        type = lib.types.attrsOf (lib.types.attrsOf lib.types.str);
        default = {};
        example = lib.literalExpression ''
          {
            core.pager = "less -R";
            color.ui = "auto";
          }
        '';
        description = ''
          Additional git config sections to include in the Nix-declared base.
          Nested attrset shape: { section.key = "value"; }.
        '';
      };
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = brokerTools.all ++ [
      pkgs.git
      awscli   # a lazy nix-stubs shim (realises awscli2 on first `aws` call)
    ];

    # configure_git_broker: Write Nix-declared git config defaults to /workspace/.gitconfig,
    # but ONLY if they're not already set (idempotent). Agent writes override and persist
    # across restarts.
    systemd.services.scooter-git-broker = {
      description = "Configure git credential helper -> broker";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = ''
        set -euo pipefail

        GITCONFIG=${lib.escapeShellArg "${cfg.home}/.gitconfig"}
        GIT="${pkgs.git}/bin/git config --file $GITCONFIG"

        mkdir -p ${lib.escapeShellArg cfg.home}

        # Write Nix-declared defaults if not already set (agent writes win).
        if ! $GIT --get user.name >/dev/null 2>&1; then
          $GIT user.name ${lib.escapeShellArg cfg.git.userName}
          echo "set user.name=${cfg.git.userName}"
        fi

        if ! $GIT --get user.email >/dev/null 2>&1; then
          $GIT user.email ${lib.escapeShellArg cfg.git.userEmail}
          echo "set user.email=${cfg.git.userEmail}"
        fi

        # Write extraConfig defaults (each section.key), but only if not set.
        ${lib.concatStrings (lib.mapAttrsToList (section: keys:
          lib.concatStrings (lib.mapAttrsToList (key: value: ''
            if ! $GIT --get ${lib.escapeShellArg "${section}.${key}"} >/dev/null 2>&1; then
              $GIT ${lib.escapeShellArg "${section}.${key}"} ${lib.escapeShellArg value}
              echo "set ${section}.${key}=${value}"
            fi
          '') keys)
        ) cfg.git.extraConfig)}

        # Set credential.helper=broker (ALWAYS, overriding extraConfig if present).
        $GIT credential.helper broker
        echo "set credential.helper=broker"
      '';
    };

    # configure_aws: render ~/.aws/config from the mounted accounts ConfigMap, one
    # [profile <name>] per account wired to the credential_process helper.
    systemd.services.scooter-aws-config = {
      description = "Render ~/.aws/config from the accounts ConfigMap";
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = ''
        accts=$(tr '\0' '\n' < /proc/1/environ | sed -n 's/^AWS_ACCOUNTS_FILE=//p' | head -1)
        accts="''${accts:-/etc/agent-sandbox/aws/accounts.json}"
        if [ -r "$accts" ]; then
          mkdir -p ${lib.escapeShellArg "${cfg.home}/.aws"}
          if ${scooterAwsCredentials}/bin/scooter-aws-credentials --render-config "$accts" > ${lib.escapeShellArg "${cfg.home}/.aws/config"} 2>/dev/null; then
            echo "rendered ${cfg.home}/.aws/config from $accts"
          fi
        fi
      '';
    };
  };
}
