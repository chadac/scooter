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

  # Git config base file (read-only, in /nix/store) — included from the writable
  # /workspace/.gitconfig via [include] directive. Carries the Nix-declared defaults
  # (user.name, user.email, extraConfig); later writes to the writable config override.
  # The shape is NixOS programs.git.config compatible (nested attrset -> INI sections).
  gitConfigBase = pkgs.writeText "scooter-gitconfig" (
    lib.generators.toINI {} (
      {
        user = {
          name = cfg.git.userName;
          email = cfg.git.userEmail;
        };
      } // cfg.git.extraConfig
    )
  );
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
      #
      # NEW: insert [include] directive at the TOP of .gitconfig (if not already
      # present), pointing to the read-only Nix base. The [include] MUST come first
      # (git is LAST-WINS, so later writes override the base). We never remove or
      # reorder existing keys (the file is agent data on a persistent PVC).
      script = ''
        set -euo pipefail

        GITCONFIG="${lib.escapeShellArg "${cfg.home}/.gitconfig"}"
        BASE="${gitConfigBase}"

        # Assert the base exists (fail loud if the build is broken).
        if ! test -r "$BASE"; then
          echo "ERROR: git config base $BASE missing or unreadable" >&2
          exit 1
        fi

        mkdir -p ${lib.escapeShellArg cfg.home}

        # If .gitconfig doesn't exist yet, create it with [include] at the top.
        if ! test -f "$GITCONFIG"; then
          cat > "$GITCONFIG" <<EOF
[include]
	path = $BASE
EOF
          echo "initialized $GITCONFIG with [include] -> $BASE"
        else
          # .gitconfig exists — check if it already includes the base.
          if ! grep -qF "path = $BASE" "$GITCONFIG" 2>/dev/null; then
            # Missing [include] — prepend it (preserve existing content).
            tmpfile=$(mktemp)
            cat > "$tmpfile" <<EOF
[include]
	path = $BASE
EOF
            cat "$GITCONFIG" >> "$tmpfile"
            mv "$tmpfile" "$GITCONFIG"
            echo "prepended [include] -> $BASE to $GITCONFIG"
          fi
        fi

        # Set credential.helper=broker (after the include, so it overrides extraConfig).
        # Use --file explicitly (not --global, which would write to /root/.gitconfig).
        broker_url=$(tr '\0' '\n' < /proc/1/environ | sed -n 's/^BROKER_URL=//p' | head -1 || true)
        if [ -n "$broker_url" ]; then
          ${pkgs.git}/bin/git config --file "$GITCONFIG" credential.helper broker || true
          echo "git credential helper -> broker ($broker_url) in $GITCONFIG"
        fi
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
