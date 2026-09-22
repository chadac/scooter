{
  contribs.gitlab = {
    src = ./.;

    # The UI row that used to be hardcoded in ui/src/{sourceIcon.tsx,
    # toolCallView.ts,sessions.ts}: a deployment without this contrib now has no
    # GitLab chip, icon or card, instead of a dead one. Why: PR #601.
    ui = {
      source = { label = "GitLab"; icon = { pack = "si"; name = "SiGitlab"; }; color = "#FC6D26"; linkProvider = true; };
      tools.gitlab_comment = {
        argKey = "body";
        action = "commented on GitLab";
        titles = [ "Comment on the GitLab MR" ];
      };
    };
    services.broker.enable = true;
    services.webhooks = {
      enable = true;
      # Only this half reads Jira keys (MR titles, branches, descriptions), and the
      # grammar is jira's. Why: PR #583.
      pythonDeps = ps: [ ps.scooterContrib.jira ];
    };
  };
}
