{
  contribs.echo = {
    src = ./.;
    services.broker.enable = true;
    services.webhooks.enable = true;
    # Never ship: echo's factory returns enabled=true unconditionally, so a
    # production broker would serve /echo/ping. Why: PR #573.
    enable = false;
  };
}
