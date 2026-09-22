{
  contribs.echo = {
    src = ./.;
    services.broker.enable = true;
    services.webhooks.enable = true;
    # Reference material: absent from every build. echo's factory returns
    # enabled=true unconditionally, so shipping it would serve /echo/ping from a
    # production broker. CI still tests it by overriding this on (flake:
    # contribsWithExamples). Why: PR #573.
    enable = false;
  };
}
