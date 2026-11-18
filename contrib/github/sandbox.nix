# github's sandbox half: `gh`, a nix-stubs shim (./stubs.nix) that
# materialises on first use. It authenticates through the broker's forge proxy
# (GH_TOKEN is a placeholder the proxy replaces), so it holds no credential.
{ pkgs, ... }:
{
  environment.systemPackages = [ pkgs.gh ];
}
