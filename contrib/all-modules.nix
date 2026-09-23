# Every contrib plus the schema, as one importable module.
#
# Explicit list, not readDir: dynamic import paths defeat Nix's import caching.
# check-contrib-coverage.sh fails CI if a contrib is missing here. Why: PR #585.
{
  imports = [
    ./options.nix

    ./airtable
    ./datadog
    ./echo
    ./gitlab
    ./grafana
    ./jira
    ./slack
  ];
}
