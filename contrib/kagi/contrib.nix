# kagi DECLARED: what this contrib IS. Deployment options: ./platform.nix.
{
  contribs.kagi = {
    src = ./.;
    services.broker.enable = true;

    # Shipped alongside brave and enableable WITH it: each tool is named for its
    # provider and each provider mounts only when its own key is set, so one image
    # carries both and a deployment picks none, one, or both.

    # No `ui` and no `skills`, for the reasons spelled out in contrib/brave/contrib.nix.
  };
}
