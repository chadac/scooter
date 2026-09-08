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
    ./stub-set.nix
    ./injected-tools.nix
    ./sample-service.nix
    ./web-services.nix
    ./carry-over.nix
    ./runtime-converge.nix
    ./broker-modules.nix
    ./local-modules.nix
    ./registry-modules.nix
    ./overlay-store.nix
    ./warm-store-seed.nix
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
  # The uv-nix uv (patched for Nix), consumed by web-services/marimo.nix to launch
  # marimo under uv so science deps import. Defaulted to null here (same reasoning as
  # nixStubsLib) so nixosTests importing modules/sandbox-os directly still evaluate;
  # marimo.nix falls back to a plain `marimo` when it's null. The image build overrides.
  _module.args.uvNix = lib.mkDefault null;

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

    # nix-stubs SHIMS, not packages: modules/sandbox-os/stubs.nix declares them and
    # the overlay (flake.nix) makes these attrs resolve to a shim carrying only the
    # build recipe, so listing them here costs kilobytes rather than closures.
    #
    # `tree` is here because goose's built-in `tree` tool reads the AGENT-HOST's
    # filesystem rather than the sandbox's, so the skills steer the agent to
    # `shell` + `tree` — which only works if `tree` resolves in here.
    uv tree
  ];

  # Defaulted here so modules can take `{ nixStubs, ... }` unconditionally: a NixOS
  # module argument is looked up in `_module.args` and a `? null` default on the
  # function does not save it. The image build overrides this (pkgs/sandbox-os);
  # a nixosTest importing modules/sandbox-os bare gets null and simply has no
  # stub overlay to vendor for the re-converge.
  _module.args.nixStubs = lib.mkDefault null;

  # The vendored nix-stubs bits the in-pod re-converge rebuilds its stub overlay
  # from; null everywhere else, which is what makes stub-set.nix inert in the
  # image build and in a bare nixosTest. Supplied by runtime-converge/base-config.nix.
  _module.args.stubBits = lib.mkDefault null;

  # Deployment-injected tools (a mounted .scooter flake). On by default like the
  # old lazyTools was: the module emits nothing until a deployment declares a tool.
  programs.injectedTools.enable = lib.mkDefault true;

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
