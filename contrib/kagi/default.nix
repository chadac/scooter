{
  contribs.kagi = {
    src = ./.;
    services.broker.enable = true;

    # Built and shipped alongside brave, and the two can both be ENABLED: each owns a
    # tool named for itself (`kagi_web_search` / `brave_web_search`), and each provider
    # mounts only when ITS key is set. So one image carries both and a deployment picks
    # none, one, or both with `agentSandbox.broker.{brave,kagi}`.

    # No `ui` and no `skills`, for the reasons spelled out in contrib/brave/default.nix.
  };
}
