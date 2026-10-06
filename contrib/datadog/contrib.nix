{
  contribs.datadog = {
    src = ./.;
    services.broker.enable = true;
    skills."scooter-datadog.md" = ./skills/scooter-datadog.md;
  };
}
