# sandbox-os' entry in scooter.images. Structure: modules/images.nix.
{ image, lib }:
{
  config.scooter.images.agent-sandbox-os.package = lib.mkDefault image;
}
