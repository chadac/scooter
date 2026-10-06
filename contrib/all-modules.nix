# Every contrib's DECLARATION plus the schema, as one importable module.
#
# Explicit list, not readDir: dynamic import paths defeat Nix's import caching.
# check-contrib-coverage.sh fails CI if a contrib is missing here. Why: PR #585.
#
# `<name>/contrib.nix`, not `<name>`: a contrib is three files, and this is the one
# every eval reads — what the contrib IS. Its deployment half (<name>/deployment.nix)
# stays out of this list because the evals that read it have no `scooter.*` tree to
# declare into; modules/platform.nix, which does, derives the halves FROM this list
# and imports them beside it. Why: #711, #719, and contrib/README.md.
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
