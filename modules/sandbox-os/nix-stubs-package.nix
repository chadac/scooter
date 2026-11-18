# nix-stubs, built identically by the image and the re-converge.

{ nixpkgs # imported plain, so neither side's overlays or config leak in
, src # the flake input, or its vendored copy
, system
}:

(import nixpkgs { inherit system; config = { }; overlays = [ ]; }).callPackage
  (src + "/nix/package.nix")
{ }
