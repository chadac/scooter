{
  contribs.grafana = {
    src = ./.;
    services.broker.enable = true;
    skills."scooter-grafana.md" = ./skills/scooter-grafana.md;
  };
}
