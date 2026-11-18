# A contrib declared outside contrib/, as a deployment would.
{
  contribs.ext-demo = {
    enable = true;
    src = ./.;
    sandbox.module = ./sandbox.nix;
  };
}
