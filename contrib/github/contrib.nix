{ lib, ... }:
{
  contribs.github = {
    options = {
      appId = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "GitHub App ID (GITHUB_APP_ID).";
      };

      installationId = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "GitHub App installation ID (GITHUB_APP_INSTALLATION_ID).";
      };

      privateKeySecret = lib.mkOption {
        type = lib.types.submodule {
          options = {
            name = lib.mkOption { type = lib.types.str; description = "Secret name (in the broker namespace)."; };
            key = lib.mkOption { type = lib.types.str; default = "private-key"; description = "Secret key holding the PEM."; };
          };
        };
        description = ''
          Secret holding the GitHub App private key (PEM). The secret must exist in
          the broker namespace.

          Enabling this contrib enables the GitHub provider, backed by a GitHub App:
          it vends installation tokens for git/HTTPS and the API.
        '';
      };
    };

    config = {
      src = ./.;
      # Moved out of ui/src/toolCallView.ts by #700, now that this contrib owns the tool.
      ui.tools.github_comment = { argKey = "body"; action = "commented on GitHub"; };

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
  };
}
