{
  contribs.aws = {
    src = ./.;
    # Sandbox half only, for now: the agent-facing tools and the ~/.aws/config
    # render. aws's service half is still broker/aws + broker/providers/aws.py,
    # blocked on two things a contrib cannot yet do — own a DB table (stage 2 of
    # #606) and reach core/authz. See #599.
    sandbox.module = ./sandbox.nix;
    skills."scooter-aws.md" = ./skills/scooter-aws.md;
  };
}
