# The contribs THIS repo's own builds and renders ship.
#
# Deliberately outside contrib/: that directory is vendored wholesale into
# sandbox-os-src (reconverge-inputs.nix), so anything in it ships inside every
# sandbox image. This is a property of this repo, not of the vended template.
#
# `contribs.<name>.enable` defaults false so a deployment opts in (#728). The
# build-time consumers -- the python packages, the sandbox image, the UI
# manifest -- have no deployment to read, so they read this.
{
  contribs = {
    airtable.enable = true;
    aws.enable = true;
    brave.enable = true;
    datadog.enable = true;
    duckduckgo.enable = true;
    github.enable = true;
    gitlab.enable = true;
    grafana.enable = true;
    jira.enable = true;
    kagi.enable = true;
    slack.enable = true;
    # echo ships nowhere; CI builds it via withModules.
  };
}
