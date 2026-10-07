{ lib, ... }:
{
  contribs.gitlab = {
    options.tokenSecret = lib.mkOption {
      type = lib.types.submodule {
        options = {
          name = lib.mkOption { type = lib.types.str; description = "Secret name (in the broker namespace)."; };
          key = lib.mkOption { type = lib.types.str; default = "GITLAB_TOKEN"; description = "Secret key holding the GitLab token."; };
        };
      };
      description = ''
        Secret holding the GitLab token (glpat-…). Injected as GITLAB_TOKEN. The
        secret must exist in the broker namespace.

        Enabling this contrib enables the GitLab provider: a transparent
        http-proxy to gitlab.com with the token injected.
      '';
    };

    config = {
      src = ./.;

      # The UI row that used to be hardcoded in ui/src/{sourceIcon.tsx,
      # toolCallView.ts,sessions.ts}: a deployment without this contrib now has no
      # GitLab chip, icon or card, instead of a dead one. Why: PR #601.
      ui = {
        source = { label = "GitLab"; icon = ./icon.svg; color = "#FC6D26"; linkProvider = true; };
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
  };
}
