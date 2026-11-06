# handoff's declaration: agents spawn new conversations, with the owner's approval,
# and recall shared ones.
# Its deployment half (./deployment.nix) lets the broker
# spawn through the router.
{ lib, ... }:

{
  contribs.handoff = { config, ... }: {
    options = {
      publicBaseUrl = lib.mkOption {
        type = lib.types.str;
        default = "";
        example = "https://scooter.example.com";
        description = ''
          UI origin for the conversation links a handoff returns and attaches
          (HANDOFF_PUBLIC_BASE_URL). Empty -> https://<ingress.host> when that is
          set, else links carry the bare conversation id.
        '';
      };
      requireApproval = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Whether the conversation's owner approves each handoff_spawn in the
          conversation before the new conversation is created
          (HANDOFF_REQUIRE_APPROVAL). The agent is told the outcome either way.
          false spawns at once, within the router's per-hour cap.
        '';
      };
      indexEvery = lib.mkOption {
        type = lib.types.str;
        default = "5m";
        description = "How often the index task folds new shared-conversation activity into search.";
      };
    };

    config = {
      src = ./.;

      # Its own database (contrib_handoff).
      db = {
        enable = true;
        tables.handoff_conversations = { };
        tables.handoff_messages = { };
        tables.handoff_spawn_requests = { };
      };

      services.broker = {
        enable = true;
        pythonDeps = ps: [ ps.aiosqlite ];
        env.HANDOFF_ENABLED = "true";
        env.HANDOFF_REQUIRE_APPROVAL = lib.boolToString config.requireApproval;
      };

      # Spawns are approved in-conversation; routing lives in ./deployment.nix.
      approvals = { };

      skills."scooter-handoff.md" = ./skills/scooter-handoff.md;

      ui.source = { label = "Handoff"; icon = ./icon.svg; };

      # Mapped in as scooter.systemTasks.handoff-index only while this contrib is enabled.
      systemTasks.index = {
        entry = "scooter_contrib_handoff.tasks:main";
        every = config.indexEvery;
        timeout = "4m";
      };
    };
  };
}
