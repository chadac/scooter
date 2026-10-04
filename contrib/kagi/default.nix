{
  contribs.kagi = {
    src = ./.;
    services.broker.enable = true;

    # Built and shipped like brave even though the two are mutually exclusive AT
    # RUNTIME: both own a tool named `web_search`, but each provider mounts only when
    # ITS key is set, so one image can carry both and a deployment chooses with
    # `agentSandbox.broker.{brave,kagi}`. Shipping it disabled would mean it is never
    # built and never tested (contrib/echo is `enable = false` because it is a
    # diagnostic, not because it conflicts).
    #
    # Setting both keys is a kubenix assertion (modules/broker.nix), with the broker's
    # duplicate-tool-name startup check as the backstop.

    # No `ui` and no `skills`, for the reasons spelled out in contrib/brave/default.nix.
  };
}
