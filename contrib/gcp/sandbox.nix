# gcp's sandbox half: gcloud, a nix-stubs shim (modules/sandbox-os/stubs.nix) that
# materialises on first use, and the placeholder token file it reads. The broker's
# forge proxy replaces the token, so the sandbox holds no credential.
{ pkgs, ... }:
let
  # The image ships these whatever the deployment enables; ./deployment.nix sets the env.
  guarded = bin: pkgs.writeShellScriptBin bin ''
    if [ -z "''${CLOUDSDK_AUTH_ACCESS_TOKEN_FILE:-}" ]; then
      echo "scooter: Google Cloud is not enabled in this deployment (contribs.gcp); no credentials are provided." >&2
    fi
    exec ${pkgs.google-cloud-sdk}/bin/${bin} "$@"
  '';
in
{
  environment.systemPackages = map guarded [ "gcloud" "gsutil" "bq" ];
  environment.etc."scooter/gcp/access-token".text = "scooter-forge-proxy";
}
