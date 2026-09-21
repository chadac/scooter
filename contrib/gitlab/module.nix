# Contrib module metadata — see contrib/README.md for the schema.
{
  name = "gitlab";
  services = [ "broker" "webhooks" ];
  pythonDeps = ps: [ ];
  # Keyed BY SERVICE, not a flat list: only the webhooks half reads Jira keys (out
  # of MR titles/branches), and a flat list put jira in the broker variant's
  # closure too — the same surface leak the per-service split exists to stop
  # (#567). Why: PR #583.
  contribDeps = { webhooks = [ "jira" ]; };
}
