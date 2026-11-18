# apikeys's declaration: personal API keys a user creates in Settings, so local
# agents (scooter-cli, scooter-skills, scooter-mode) reach Scooter without a
# browser session. The broker holds the keys; webhooks serves the endpoint.
{ ... }:

{
  contribs.apikeys = {
    src = ./.;

    # Its own database, contrib_apikeys, migrated from ./sql.
    db = {
      enable = true;
      # Webhooks reaches keys only through the broker's verify route.
      tables.api_keys.writers = [ "broker" ];
    };

    services.broker = {
      enable = true;
      env.APIKEYS_ENABLED = "true";
    };

    services.webhooks = {
      enable = true;
      pythonDeps = ps: [ ps.httpx ps.limits ];
      env.APIKEYS_WEBHOOKS_ENABLED = "true";
    };

    ui.settingsTabs = [{
      label = "API keys";
      order = 60;
      entry = "ui/SettingsTab.tsx";
      api = true;
    }];
  };
}
