# Every contrib plus the schema, as one module you can simply import.
#
# The import list is EXPLICIT, not a readDir: a dynamic list makes every eval walk
# the directory and defeats Nix's import caching, and this list changes about once
# a quarter. Each contrib is a directory (its module is that directory's
# default.nix), so an entry is just the path.
#
# Forgetting to add one here would leave a contrib silently unbuilt AND untested,
# which is the rot #573 is about — so `scripts/check-contrib-coverage.sh` compares
# this list against the tree in CI, outside Nix eval where it costs nothing.
# Why: PR #585.
{
  imports = [
    ./options.nix

    ./datadog
    ./echo
    ./gitlab
    ./jira
  ];
}
