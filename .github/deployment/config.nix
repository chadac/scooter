# The contribs this repo's own builds and renders ship. It lives outside contrib/
# because that directory is vendored wholesale into every sandbox image, and this
# is a property of this repo rather than the vended template. `contribs.<name>.enable`
# defaults false, so the build-time consumers (the python packages, the sandbox
# image, the UI manifest) read this.
{
  contribs = {
    airtable.enable = true;
    ask-user.enable = true;
    aws.enable = true;
    brave.enable = true;
    code-server.enable = true;
    datadog.enable = true;
    duckduckgo.enable = true;
    files.enable = true;
    github.enable = true;
    # Builds the linked-account table and Settings tab; a deployment adds the OAuth client.
    github.userAuth.enable = true;
    gitlab.enable = true;
    gitlab.userAuth.enable = true;
    google.enable = true;
    grafana.enable = true;
    jira.enable = true;
    kagi.enable = true;
    marimo.enable = true;
    personalization.enable = true;
    shares.enable = true;
    slack.enable = true;
    ssh.enable = true;
    # echo ships nowhere; CI builds it via withModules.
  };
}
