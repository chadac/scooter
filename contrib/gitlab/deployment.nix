# gitlab's deployment half: env that points `glab` in every sandbox pod at the forge
# proxy, and the OAuth callback URL user auth hands GitLab.
{ config, lib, ... }:

let
  ccfg = config.contribs.gitlab;
  host = config.scooter.ingress.host;
in
{
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
    # Placeholder token; the forge proxy swaps in the real one.
    scooter.sandboxPod.extraEnv = [
      { name = "GITLAB_HOST"; value = ccfg.host; }
      { name = "GITLAB_TOKEN"; value = "scooter-forge-proxy"; }
    ];

    # The relay maps /contrib-api/gitlab/<x> to the broker's /gitlab/user/<x>.
    scooter.broker.extraEnv = lib.mkIf (ccfg.userAuth.enable && host != "") [
      { name = "GITLAB_OAUTH_REDIRECT_URL"; value = "https://${host}/contrib-api/gitlab/callback"; }
    ];
  };
}
