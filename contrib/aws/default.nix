{
  contribs.aws = {
    src = ./.;

    # Both halves live here now (#599). The service half needed two things a
    # contrib could not do when #617 moved the sandbox half: reach the authorizer
    # without constructing one (BrokerContext, #624) and read the shared broker DB
    # without reassembling it (StoreConfig on the surface, #622).
    services.broker = {
      enable = true;
      # boto3 came with the provider — it was in the broker app's closure solely
      # for this integration's IAM/STS calls.
      pythonDeps = ps: [ ps.boto3 ];
    };

    sandbox.module = ./sandbox.nix;
    skills."scooter-aws.md" = ./skills/scooter-aws.md;
  };
}
