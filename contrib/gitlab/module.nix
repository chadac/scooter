# Contrib module metadata — see contrib/README.md for the schema.
{
  name = "gitlab";
  services = [ "broker" "webhooks" ];
  # Only the webhooks half reads Jira keys (MR titles, branches, descriptions), and
  # the key grammar is jira's. Why: PR #583.
  pythonDeps = service: ps:
    if service == "webhooks" then [ ps.scooterContribJira ] else [ ];
}
