# Every contrib in the tree: NAME -> { dir; ship; }.
#
# The ONE list. Explicit, not readDir: dynamic import paths defeat Nix's import
# caching, and check-contrib-coverage.sh fails CI if a contrib on disk is missing
# here. Why: PR #585.
#
# `ship` is SHIPPEDNESS, and it is written here rather than inside the contrib
# because it has to be readable WITHOUT evaluating anything: modules/platform.nix
# turns it into an `imports` list, and `imports` is resolved before any option can
# be read (reading one there is `infinite recursion`, not an error you can catch —
# #615). Stating it as a source fact is what lets a contrib that ships nowhere have
# deployment options that DO NOT EXIST rather than options that are ignored. Why:
# #599, #711.
#
# A `ship = false` contrib is still built by CI through `withModules`
# (contrib/default.nix), which is how it stays compiled and tested.
{
  airtable = { dir = ./airtable; ship = true; };
  aws = { dir = ./aws; ship = true; };
  brave = { dir = ./brave; ship = true; };
  datadog = { dir = ./datadog; ship = true; };
  duckduckgo = { dir = ./duckduckgo; ship = true; };
  github = { dir = ./github; ship = true; };
  gitlab = { dir = ./gitlab; ship = true; };
  grafana = { dir = ./grafana; ship = true; };
  jira = { dir = ./jira; ship = true; };
  kagi = { dir = ./kagi; ship = true; };
  slack = { dir = ./slack; ship = true; };

  # Never ship: echo's factory returns enabled=true unconditionally, so a
  # production broker would serve /echo/ping. It exists as the fixture for the
  # extension surfaces — the one contrib that can prove the "built but not
  # shipped" path stays working. Why: PR #573, #651.
  echo = { dir = ./echo; ship = false; };
}
