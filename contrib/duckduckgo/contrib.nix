# duckduckgo DECLARED: what this contrib IS. Deployment options: ./platform.nix.
{
  contribs.duckduckgo = {
    src = ./.;
    services.broker.enable = true;

    # No `ui` and no `skills`, for the reasons in contrib/brave/contrib.nix. What is
    # specific to this provider — keyless, least reliable — lives in the tool's
    # docstring, which is what the agent reads when choosing between search tools.
  };
}
