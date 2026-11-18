# The stub overlay, shared by image build and re-converge.

{ lockLib # nix-stubs' pure-Nix lib (the flake's `lib`, or the vendored nix/lock.nix)
, nix-stubs # the prebuilt binary, since a callPackage here would compile Rust in-pod
  # name -> { dir; flakeLock; }; `dir` holds stubs.nix and stubs.lock.
, sets
  # Extra stubs.nix arguments; each gets only those it declares.
, stubArgs ? { }
}:

lockLib.mkOverlay {
  sets = builtins.mapAttrs
    (_: s: {
      stubs = p:
        let f = import (s.dir + "/stubs.nix"); in
        f (builtins.intersectAttrs (builtins.functionArgs f) ({ pkgs = p; } // stubArgs));
      lock = s.dir + "/stubs.lock";
      inherit (s) flakeLock;
    })
    sets;
  inherit nix-stubs;
}
