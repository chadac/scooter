{
  contribs.echo = {
    src = ./.;
    services.broker.enable = true;
    services.webhooks.enable = true;
    # Built and tested, never shipped. echo's factory returns enabled=true
    # unconditionally, so shipping it would serve /echo/ping from the production
    # broker. Why: PR #573.
    enable = false;
  };
}
