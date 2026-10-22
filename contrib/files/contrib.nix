# files' declaration: a sandbox-side viewer over the workspace, the broker-side
# store its review surface syncs to, and the skill that teaches the agent to open
# it for the user. Its deployment half is ./deployment.nix and its sandbox half
# ./sandbox.nix. `enable` stays opt-in like every other contrib; this repo's own
# builds turn it on in .github/deployment/config.nix.
{ lib, ... }:

{
  contribs.files = {
    options.annotations.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Mount the annotation store (PUT/GET /files/annotations/*) the viewer syncs
        a reviewer's comments and answers to, persisted in this contrib's own
        database. Once the broker stores a remark, the viewer prompts its
        conversation through the conversation router's sandbox self-access
        listener, so the agent wakes on it; that needs
        `scooter.conversationController.selfAccess.enable`, and without it remarks are
        stored but the agent is not told.

        On by default: a viewer whose comments are not durable loses them with the
        sandbox, and the agent never hears them. Set false to ship the viewer as a
        read-only file browser — the routes are then ABSENT, which is the 404 the
        viewer reads as "not enabled here".
      '';
    };

    config = {
      src = ./.;

      # The brand row a review remark's system event wears in the thread.
      ui.source = { label = "Files"; icon = ./icon.svg; };

      # Its own database (contrib_files), so its Atlas history in ./sql is its own.
      # copyFrom moves the rows out of `broker` once. A deployment with
      # scooter.dbMigrate.retireCopiedTables then drops the broker table; copyFrom
      # goes once every deployment has.
      db = {
        enable = true;
        tables.annotations.copyFrom = "broker";
      };

      # The broker half is the annotation store; the viewer itself runs in the
      # sandbox (./sandbox.nix) on the stdlib and is not packaged.
      services.broker = {
        enable = true;
        # The SQLite driver behind StoreConfig's local default, which is also what
        # the suite runs the store against (Postgres owns the deployed schema).
        pythonDeps = ps: [ ps.aiosqlite ];
      };

      sandbox.module = ./sandbox.nix;
      skills."scooter-files.md" = ./skills/scooter-files.md;
      skills."scooter-design-review.md" = ./skills/scooter-design-review.md;
    };
  };
}
