{
  contribs.echo = {
    src = ./.;
    # The fixture for the sandbox surface: echo ships nowhere, so it is the only
    # contrib that can carry one until aws moves (#599).
    sandbox.module = ./sandbox.nix;
    services.broker.enable = true;
    services.webhooks.enable = true;
    # Never ship: echo's factory returns enabled=true unconditionally, so a
    # production broker would serve /echo/ping. Why: PR #573.
    enable = false;
  };
}
