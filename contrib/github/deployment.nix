# github's deployment half: env that points `gh` in every sandbox pod at the forge
# proxy, and the OAuth callback URL user auth hands GitHub.
{ config, lib, ... }:

let
  ccfg = config.contribs.github;
  host = config.scooter.ingress.host;
in
{
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
    # Placeholder token; the forge proxy swaps in the real one.
    scooter.sandboxPod.extraEnv =
      if ccfg.host == "github.com" then [ { name = "GH_TOKEN"; value = "scooter-forge-proxy"; } ]
      else [
        { name = "GH_HOST"; value = ccfg.host; }
        { name = "GH_ENTERPRISE_TOKEN"; value = "scooter-forge-proxy"; }
      ];

    # The relay maps /contrib-api/github/<x> to the broker's /github/user/<x>.
    scooter.broker.extraEnv = lib.mkIf (ccfg.userAuth.enable && host != "") [
      { name = "GITHUB_OAUTH_REDIRECT_URL"; value = "https://${host}/contrib-api/github/callback"; }
    ];
  };
}
