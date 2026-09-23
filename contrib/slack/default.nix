{
  contribs.slack = {
    src = ./.;
    services.broker.enable = true;
    services.webhooks.enable = true;
  };
}
