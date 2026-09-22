{
  contribs.github = {
    src = ./.;
    # pyjwt+cryptography sign the RS256 App JWT. Both halves mint one (the broker
    # vends git/API tokens, webhooks posts comments), and neither app carries the
    # dep any more. Why: PR #591.
    services.broker = {
      enable = true;
      pythonDeps = ps: [ ps.pyjwt ps.cryptography ];
    };
    services.webhooks = {
      enable = true;
      pythonDeps = ps: [ ps.pyjwt ps.cryptography ];
    };
  };
}
