# `contribs.<name>.type = "tokenproxy"`: tell the broker each API and mount its token
# at <dir>/<name>/token, so a provider needs only Nix (broker/providers/tokenproxy.py).

{ config, lib, ... }:

let
  dir = "/var/run/scooter/tokenproxy";
  proxies = lib.filterAttrs (_: c: c.enable && c.type == "tokenproxy") config.contribs;
  volume = name: "tokenproxy-${name}";
in
{
  config = lib.mkIf (config.scooter.broker.enable && proxies != { }) {
    scooter.broker.extraEnv = [
      { name = "TOKENPROXY_PROVIDERS"; value = builtins.toJSON (lib.mapAttrs (_: c: {
          inherit (c.tokenproxy) url apiPrefixes;
          credential = { inherit (c.tokenproxy.credential) kind headerName; };
        }) proxies); }
      { name = "TOKENPROXY_DIR"; value = dir; }
    ];
    scooter.broker.extraVolumes = lib.mapAttrsToList (name: c: {
      name = volume name;
      secret = {
        secretName = c.tokenproxy.credential.secret.name;
        items = [ { key = c.tokenproxy.credential.secret.key; path = "token"; } ];
        optional = true;
      };
    }) proxies;
    scooter.broker.extraVolumeMounts = lib.mapAttrsToList (name: _: {
      name = volume name;
      mountPath = "${dir}/${name}";
      readOnly = true;
    }) proxies;
  };
}
