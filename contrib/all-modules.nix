# Every contrib's declaration plus the schema, as one importable module. An
# explicit list (dynamic import paths defeat import caching), and
# check-contrib-coverage.sh fails CI if a contrib is missing. Deployment halves
# stay out, since modules/platform.nix derives them from this list.
{
  imports = [
    ./spec.nix

    ./airtable/contrib.nix
    ./ask-user/contrib.nix
    ./aws/contrib.nix
    ./brave/contrib.nix
    ./code-server/contrib.nix
    ./commits/contrib.nix
    ./datadog/contrib.nix
    ./docker/contrib.nix
    ./duckduckgo/contrib.nix
    ./echo/contrib.nix
    ./files/contrib.nix
    ./gcp/contrib.nix
    ./github/contrib.nix
    ./google/contrib.nix
    ./gitlab/contrib.nix
    ./grafana/contrib.nix
    ./imagegen/contrib.nix
    ./jira/contrib.nix
    ./kagi/contrib.nix
    ./marimo/contrib.nix
    ./mcpservers/contrib.nix
    ./personalization/contrib.nix
    ./shares/contrib.nix
    ./skills/contrib.nix
    ./slack/contrib.nix
    ./ssh/contrib.nix
  ];
}
