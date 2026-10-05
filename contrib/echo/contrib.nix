# echo DECLARED: what this contrib IS. No ./platform.nix — it ships nowhere
# (ship = false in contrib/contribs.nix), so it has no deployment options at all.
{
  contribs.echo = {
    src = ./.;
    # The fixture for the sandbox surface. aws now ships a real one, so this covers
    # what aws cannot: a contrib that SHIPS NOWHERE (ship = false in
    # contrib/contribs.nix), reached by the check through `extraModules`.
    sandbox.module = ./sandbox.nix;
    services.broker.enable = true;
    services.webhooks.enable = true;

    # The SECOND consumer of the approval seam, and the reason it can be tested
    # end to end without mocking one integration's cloud APIs. Declared exactly as
    # aws declares its own — if this needed anything aws-shaped, the seam would not
    # be general. Why: PR #651.
    approvals = {
      # Deliberately NOT the defaults: a test that passes with every contrib sharing
      # one hardcoded string cannot tell "read from the manifest" apart from "guessed
      # aws's copy".
      blockedTitle = "Only a reviewer can approve an echo request.";
      blockedHint = "You can't approve this echo request — ask a reviewer.";
    };
  };
}
