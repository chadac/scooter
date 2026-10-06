{
  contribs.github = {
    src = ./.;
    # pyjwt+cryptography sign the RS256 App JWT. Both halves mint one (the broker
    # vends git/API tokens, webhooks posts comments), and neither app carries the
    # dep any more. Why: PR #591.
    # Moved out of ui/src/toolCallView.ts by #700, now that this contrib owns the tool.
    ui.tools.github_comment = { argKey = "body"; action = "commented on GitHub"; };
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
