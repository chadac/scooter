{ lib, buildPkgs, ... }:

{
  # Built here so CI runs its Go tests.
  scooter.packages.scooter-review = lib.mkDefault (buildPkgs.callPackage ./review { });
}
