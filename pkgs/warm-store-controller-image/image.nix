{ pkgs, lib, n2c, warmStoreController, ... }:

# OCI image for the warm /nix/store PVC pool controller.

let
  image = n2c.buildImage {
    name = "warm-store-controller";
    tag = "latest";
    copyToRoot = pkgs.buildEnv {
      name = "warm-store-controller-root";
      paths = [ warmStoreController pkgs.cacert ];
      pathsToLink = [ "/bin" "/etc/ssl" ];
    };
    config = {
      Entrypoint = [ "${warmStoreController}/bin/warm-store-controller" ];
      Env = [ "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt" ];
    };
  };
in
# A kubenix module: this image declares its own scooter.images entry.
{
  config.scooter.images.warm-store-controller = {
    package = lib.mkDefault image;
    attr = "warm-store-controller-image";
    refKey = "warmStoreController";
  };
}
