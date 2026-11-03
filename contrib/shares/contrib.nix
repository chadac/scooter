# shares' declaration: agents publish static bundles that the broker serves at
# /s/<uuid>/, stored in this contrib's own database. Its deployment half is
# ./deployment.nix. Its UI half is the Shares section and the inline `scooter-embed` block.
{ lib, ... }:

{
  contribs.shares = {
    options = {
      publicBaseUrl = lib.mkOption {
        type = lib.types.str;
        default = "";
        example = "https://scooter.example.com";
        description = ''
          External origin used to build the returned share URL
          (SHARES_PUBLIC_BASE_URL). Empty -> defaults to https://<ingress.host>
          when that is set, else a relative /s/<uuid>/ URL.
        '';
      };
      frameAncestors = lib.mkOption {
        type = lib.types.str;
        default = "";
        example = "https://scooter.example.com";
        description = ''
          CSP frame-ancestors allowlist for embedding a served share in an
          <iframe> (SHARES_FRAME_ANCESTORS) — the UI origin(s), space-separated.
          Empty -> defaults to https://<ingress.host> when set, else the broker's
          own `'self'` default (same-origin only).
        '';
      };
    };

    config = {
      src = ./.;

      # Its own database (contrib_shares). copyFrom moves the rows out of `broker`
      # once; a deployment with scooter.dbMigrate.retireCopiedTables then drops the
      # broker tables, and copyFrom goes once every deployment has.
      db = {
        enable = true;
        tables.static_shares.copyFrom = "broker";
        tables.static_share_versions.copyFrom = "broker";
      };

      services.broker = {
        enable = true;
        # Share links, served unauthenticated; the UUID is the capability.
        publicPaths = [ "/s/" ];
        # The SQLite driver the suite runs the store against.
        pythonDeps = ps: [ ps.aiosqlite ];
      };

      skills."scooter-publish.md" = ./skills/scooter-publish.md;

      ui = {
        # Lists this conversation's shares through the conversation relay.
        panel = { label = "Shares"; entry = "ui/Panel.tsx"; api = true; };
        # A published share drawn inline as a sandboxed iframe.
        markdownFences."scooter-embed".entry = "ui/Embed.tsx";
      };
    };
  };
}
