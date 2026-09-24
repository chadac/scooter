{
  contribs.echo = {
    src = ./.;
    # The fixture for the sandbox surface. aws now ships a real one, so this covers
    # what aws cannot: a contrib that is DISABLED in the repo, reached by the check
    # through `extraModules`.
    sandbox.module = ./sandbox.nix;
    services.broker.enable = true;
    services.webhooks.enable = true;
    # Never ship: echo's factory returns enabled=true unconditionally, so a
    # production broker would serve /echo/ping. Why: PR #573.
    enable = false;
  };
}
