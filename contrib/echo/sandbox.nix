# echo's sandbox half — the reference for `contribs.<name>.sandbox.module`.
#
# A plain NixOS module, layered into the sandbox-os config at image build and
# re-derived from the vendored source by every in-pod re-converge. Everything NixOS
# offers is available: packages, systemd units, activation, environment.
# aws is the real consumer (the `~/.aws/config` render + the awscli2 stub that
# modules/sandbox-os/carry-over.nix carries today). See #599.
{ pkgs, ... }:

{
  environment.systemPackages = [
    (pkgs.writeShellScriptBin "echo-contrib-hello" ''
      echo "hello from the echo contrib"
    '')
  ];

  # The marker dev-env-contrib-sandbox asserts on — cheap to evaluate, and it proves
  # the module reached the sandbox config rather than merely being a valid file.
  environment.etc."scooter/contrib-echo".text = "echo contrib sandbox module\n";
}
