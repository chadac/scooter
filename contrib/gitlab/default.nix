{
  contribs.gitlab = {
    src = ./.;
    services.broker.enable = true;
    services.webhooks = {
      enable = true;
      # Only this half reads Jira keys (MR titles, branches, descriptions), and the
      # grammar is jira's. Why: PR #583.
      pythonDeps = ps: [ ps.scooterContrib.jira ];
    };
  };
}
