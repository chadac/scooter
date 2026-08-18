# A tiny stand-in config/root (the test's base config). Declares the marker service module
# but leaves it OFF — config/custom turns it on / overrides it. keep-backdoor keeps the
# nixosTest control channel alive across the switch (else `scooter-rebuild switch` hangs the driver).
{ ... }: {
  imports = [ ./marker.nix ./keep-backdoor.nix ];
  services.markerService.enable = false;
}
