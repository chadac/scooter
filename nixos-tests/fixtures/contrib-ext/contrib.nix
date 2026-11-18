# A contrib declared outside contrib/, as a deployment would.
{
  contribs.ext-demo = {
    enable = true;
    src = ./.;
    sandbox.module = ./sandbox.nix;
    # A store copy, vendored like an external flake.lock.
    sandbox.stubs.flakeLock = builtins.path { path = ../../../flake.lock; name = "flake.lock"; };
  };
}
