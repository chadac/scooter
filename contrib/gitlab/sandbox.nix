# gitlab's sandbox half: `glab`, a nix-stubs shim (modules/sandbox-os/stubs.nix) that
# materialises on first use. It authenticates through the broker's forge proxy
# (GITLAB_TOKEN is a placeholder the proxy replaces), so it holds no credential.
{ pkgs, ... }:
{
  # The image ships glab whatever the deployment enables; ./deployment.nix sets the env.
  environment.systemPackages = [
    (pkgs.writeShellScriptBin "glab" ''
      if [ -z "''${GITLAB_TOKEN:-}" ]; then
        echo "scooter: GitLab is not enabled in this deployment (contribs.gitlab); no credentials are provided." >&2
      fi
      exec ${pkgs.glab}/bin/glab "$@"
    '')
  ];
}
