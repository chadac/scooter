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

    # Its own deployment options + manifests, instead of ~40 aws references in
    # modules/broker.nix (#599).
    deployment.module = ./deployment.nix;

    sandbox.module = ./sandbox.nix;
    skills."scooter-aws.md" = ./skills/scooter-aws.md;

    # A grant needs a human to say yes. The doubled prefix is the core mounting every
    # provider under /{provider.name} plus this transport's own /aws route prefix.
    # pendingPath is set because these requests MUST survive a rollout: the agent is
    # blocked on the answer, and an approval window that vanishes leaves a user who
    # cannot act and an agent that never proceeds.
    approvals = {
      brokerPrefix = "/aws/aws";
      pendingPath = "/aws/aws/pending";
    };
  };
}
