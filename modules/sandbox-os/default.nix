# The sandbox dev-environment NixOS configuration.
#
# This is the SHARED config — the capabilities (lazy tool stubs, sample service,
# in-pod nix) that must be true both in the deployed CONTAINER and in a nixosTest
# VM. Imported by both:
#   - the image build (pkgs/sandbox-os) adds `boot.isContainer = true` so systemd
#     runs as PID 1 with the kernel/udev/hardware/boot units trimmed;
#   - a nixosTest node imports this WITHOUT isContainer, so it boots as a normal
#     QEMU VM (which needs a kernel/initrd that isContainer removes) and exercises
#     the same units/stubs/services.
# Keeping `boot.isContainer` OUT of here is deliberate: it's a packaging concern,
# not a capability, and it's incompatible with the VM boot the tests rely on.
#
# See docs/DEV_ENVIRONMENT_DESIGN.md.

{ config, lib, pkgs, ... }:

{
  imports = [
    ./nix-config.nix
    ./lazy-tools.nix
    ./sample-service.nix
    ./web-services.nix
    ./carry-over.nix
    ./runtime-converge.nix
    ./broker-modules.nix
    ./local-modules.nix
    ./registry-modules.nix
    ./overlay-store.nix
    ./dbus-container.nix
  ];

  # The agent-editable modules dir lives on the workspace PVC (durable + writable:
  # HOME=/workspace) and is exposed at the stable /etc/scooter/modules path via a
  # symlink. The agent edits *.nix there + runs scooter-apply-module; local-modules.nix
  # imports them. tmpfiles creates the PVC dir + the symlink on boot (idempotent).
  systemd.tmpfiles.rules = [
    "d /workspace/.scooter/modules 0755 root root -"
    "L+ /etc/scooter/modules - - - - /workspace/.scooter/modules"
  ];

  # nix-stubs' lib (mkLazyPackage), consumed by carry-over.nix to lazy-shim awscli2.
  # Default it to null HERE so importers that DON'T provide it — the nixosTests,
  # which import modules/sandbox-os directly, not through pkgs/sandbox-os — still
  # evaluate (carry-over.nix then falls back to the real package). The image build
  # (pkgs/sandbox-os) overrides this with the real lib via its own _module.args
  # (a plain definition outranks this mkDefault). Without the default, referencing
  # `nixStubsLib` as a module arg errors "attribute 'nixStubsLib' missing".
  _module.args.nixStubsLib = lib.mkDefault null;

  # --- systemd base ----------------------------------------------------------
  system.stateVersion = "24.11";

  # No display/doc/etc. — keep it lean.
  documentation.enable = lib.mkDefault false;

  # In a k8s pod the kubelet/CNI owns networking and there's no host name-service
  # cache — dhcpcd + nscd just fail and leave the system "degraded". Turn them off
  # so a healthy boot reaches "running". (Harmless in a VM too.)
  networking.dhcpcd.enable = lib.mkDefault false;
  services.nscd.enable = lib.mkDefault false;
  # nscd off needs an explicit NSS module set.
  system.nssModules = lib.mkForce [ ];

  # --- nix usable in-pod (the agent builds/installs on demand) ---------------
  # cache.nixos.org egress is available in-pod (confirmed) — first-call lazy
  # stub builds substitute from it instead of building from source.
  nix.settings.substituters = lib.mkDefault [ "https://cache.nixos.org/" ];

  # Flakes + pinned `nixpkgs` registry + the user nix-profile on PATH, so
  # `nix profile install nixpkgs#x` (the skill) and `nix run nixpkgs#x` work.
  devEnvNix = {
    enable = true;
    nixpkgs = lib.mkDefault "github:NixOS/nixpkgs/nixos-unstable";
  };

  # --- base packages: DELIBERATELY MINIMAL (lazy stubs cover the rest) -------
  environment.systemPackages = with pkgs; [
    bashInteractive coreutils findutils gnugrep gnused gawk
    git curl jq gnutar gzip cacert
    # util-linux for `setsid` — background jobs (run_background) detach into their
    # own session/process-group so they survive the exec shell and can be reaped
    # as a group later. coreutils' nohup alone can't create a process group.
    util-linux
  ];

  # --- the lazy-tool stubs (extensible; uv shipped) --------------------------
  programs.lazyTools = {
    enable = true;
    # Built-in fallback pin; the live pod overrides via the pinFile ConfigMap.
    # STAGE 5: set this to a concrete fixed rev.
    defaultNixpkgs = lib.mkDefault "github:NixOS/nixpkgs/nixos-unstable";
    tools.uv = { package = "uv"; };
    # `tree` as a lazy stub: the agent reaches for it to list directories, and its
    # goose developer `tree` tool reads the WRONG filesystem (the agent-host pod,
    # not the sandbox) — so we steer it to `shell` + `tree` (see identityPrompt).
    # Ship it lazily so that shell `tree` actually resolves in the sandbox.
    tools.tree = { package = "tree"; };
  };

  # --- the PoC sample service ------------------------------------------------
  services.sampleDevService.enable = true;

  # --- broker/git/aws carry-over from the legacy sandbox image ---------------
  # So the agent-host's exec'd commands (broker whoami, brokered git, AWS
  # credential_process) work unchanged in the new image.
  programs.scooterCarryOver.enable = true;

  # STAGE 5 carry-over (from the old entrypoint.sh, must not regress):
  #   - broker tools (agent-broker, git-credential-broker, scooter-aws*)
  #   - git credential.helper = broker (when BROKER_URL set)
  #   - ~/.aws/config render from the accounts ConfigMap
  #   - HOME pinned to the writable workspace for exec'd commands
  # These become packages / systemd units / activation scripts here.
}
