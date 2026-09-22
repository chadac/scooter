{
  contribs.gitlab = {
    src = ./.;
    services.broker.enable = true;
    services.webhooks = {
      enable = true;
      # Only the webhooks half reads Jira keys (MR titles, branches, descriptions),
      # and the key grammar is jira's. Why: PR #583.
      pythonDeps = ps: [ ps.scooterContribJira ];
    };
  };
}
