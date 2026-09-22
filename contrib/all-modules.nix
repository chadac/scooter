# Every contrib plus the schema, as one module you can simply import.
#
# Discovery is still `readDir`, not a hand-written import list: a new
# contrib/<name>/module.nix is picked up the moment it exists, so adding a contrib
# stays "make a directory" and cannot fail by forgetting to register it here.
# Why: PR #585.
{ lib, ... }:

let
  entries = builtins.readDir ./.;
  dirs = lib.filter
    (n: entries.${n} == "directory" && builtins.pathExists (./. + "/${n}/module.nix"))
    (lib.attrNames entries);
in
{
  imports = [ ./options.nix ] ++ map (n: ./. + "/${n}/module.nix") dirs;
}
