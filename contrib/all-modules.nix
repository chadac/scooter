# Every contrib's DECLARATION plus the schema, as one importable module.
#
# Explicit list, not readDir: dynamic import paths defeat Nix's import caching.
# check-contrib-coverage.sh fails CI if a contrib is missing here. Why: PR #585.
#
# `<name>/contrib.nix`, not `<name>`: a contrib's three halves land in three
# different evals and are named for them, and this is the one every eval reads.
# The platform half is reached from here too, but only through
# contrib/platform-modules.nix — the eval that has a `scooter.*` tree to declare
# into. Why: #711, and contrib/README.md.
{
  imports = [
    ./spec.nix

    ./airtable/contrib.nix
    ./aws/contrib.nix
    ./brave/contrib.nix
    ./datadog/contrib.nix
    ./duckduckgo/contrib.nix
    ./echo/contrib.nix
    ./github/contrib.nix
    ./gitlab/contrib.nix
    ./grafana/contrib.nix
    ./jira/contrib.nix
    ./kagi/contrib.nix
    ./slack/contrib.nix
  ];
}
