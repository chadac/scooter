# Every contrib's declaration plus the schema, as one importable module. An
# explicit list (dynamic import paths defeat import caching), and
# check-contrib-coverage.sh fails CI if a contrib is missing. Deployment halves
# stay out, since modules/platform.nix derives them from this list.
{
  imports = [
    ./spec.nix

    ./airtable/contrib.nix
    ./aws/contrib.nix
    ./brave/contrib.nix
    ./code-server/contrib.nix
    ./datadog/contrib.nix
    ./duckduckgo/contrib.nix
    ./echo/contrib.nix
    ./files/contrib.nix
    ./github/contrib.nix
    ./gitlab/contrib.nix
    ./grafana/contrib.nix
    ./jira/contrib.nix
    ./kagi/contrib.nix
    ./marimo/contrib.nix
    ./slack/contrib.nix
  ];
}
