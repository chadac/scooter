# web-review's declaration: "Review", a web service that frames this conversation
# beside an app the user is building, with notes pinned on the app that wake the
# agent. Sandbox-only, plus its skill and the brand row its notes wear in the
# thread. `enable` stays opt-in like every other contrib; this repo's own builds
# turn it on in .github/deployment/config.nix. Review itself stays off and unlisted
# until `review target` sets webReview.target.
{
  contribs.web-review = {
    src = ./.;
    sandbox.module = ./sandbox.nix;
    ui.source = { label = "Review"; icon = ./icon.svg; };
    skills."scooter-web-review.md" = ./skills/scooter-web-review.md;
  };
}
