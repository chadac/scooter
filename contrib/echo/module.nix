# Contrib module metadata — the thin, declarative descriptor the Nix build reads
# to place this contrib's package into the right service image(s).
#
# Schema (see contrib/README.md):
#   name        : contrib id (the package is scooter-contrib-<name>, importable
#                 as scooter_contrib_<name>).
#   services    : which services this contrib plugs into. Must match the
#                 entry-point groups declared in the package's pyproject.toml
#                 ("broker" -> agent_broker.providers,
#                  "webhooks" -> scooter_webhooks.handlers). contrib/default.nix
#                 buckets the built package into each named service's contrib list.
#   pythonDeps  : optional extra Python deps beyond what the host service already
#                 provides (a function of the python package set). fastapi is
#                 always available in both services, so echo needs nothing extra.
{
  name = "echo";
  services = [ "broker" "webhooks" ];
  pythonDeps = _: _: [ ];
  # Built and tested, never shipped. echo's factory returns enabled=true
  # unconditionally, so shipping it would serve /echo/ping from the production
  # broker. Why: PR #573.
  example = true;
}
