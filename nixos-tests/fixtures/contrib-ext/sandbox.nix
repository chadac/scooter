# Reads siblings under `src`, so re-converge needs it all vendored.
{ pkgs, ... }:
{
  imports = [ ./etc.nix ];
  environment.systemPackages = [
    (pkgs.writeShellScriptBin "contrib-ext-demo" (builtins.readFile ./demo.sh))
    # A shim from ./stubs.nix.
    pkgs.hello
  ];
}
