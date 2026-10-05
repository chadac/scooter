{
  contribs.kagi = {
    src = ./.;
    services.broker.enable = true;

    # The option tree an operator configures (`agentSandbox.broker.kagi.*`) and the
    # broker env it renders. Why it lives here and not in modules/broker.nix: #599.
    deployment.module = ./deployment.nix;

    # Shipped alongside brave and enableable WITH it: each tool is named for its
    # provider and each provider mounts only when its own key is set, so one image
    # carries both and a deployment picks none, one, or both.

    # No `ui` and no `skills`, for the reasons spelled out in contrib/brave/default.nix.
  };
}
