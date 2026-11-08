# commits' declaration: the name and email a user's commits carry. The user sets it
# on a settings tab; an agent may propose one, which the user approves in Approvals.
{ ... }:

{
  contribs.commits = {
    src = ./.;
    sandbox.module = ./sandbox.nix;

    # Its own database, contrib_commits, with its own Atlas history.
    db = {
      enable = true;
      tables.commit_identities = { };
      # Unwritten; kept for decided rows, dropped next release.
      tables.commit_identity_proposals = { };
    };

    services.broker = {
      enable = true;
      pythonDeps = ps: [ ps.aiosqlite ];
      env.COMMITS_ENABLED = "true";
    };

    # Proposals are approved in-conversation, at /commits/approvals.
    approvals = { };
    ui.interruptRenderers."commits.identity".entry = "ui/ProposalCard.tsx";

    skills."commit-identity.md" = ./skills/commit-identity.md;

    ui.settingsTabs = [{
      label = "Commit identity";
      order = 48;
      entry = "ui/SettingsTab.tsx";
      api = true;
    }];
  };
}
