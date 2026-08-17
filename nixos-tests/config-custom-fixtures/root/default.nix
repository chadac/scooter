# A tiny stand-in config/root (the test's base config). Declares the marker service module
# but leaves it OFF — config/custom turns it on / overrides it.
{ ... }: {
  imports = [ ./marker.nix ];
  services.markerService.enable = false;
}
