{
  contribs.duckduckgo = {
    src = ./.;
    services.broker.enable = true;

    # The option tree an operator configures (`agentSandbox.broker.duckduckgo.enable`).
    deployment.module = ./deployment.nix;

    # No `ui` and no `skills`, for the reasons in contrib/brave/default.nix. What is
    # specific to this provider — keyless, least reliable — lives in the tool's
    # docstring, which is what the agent reads when choosing between search tools.
  };
}
