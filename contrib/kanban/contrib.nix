# kanban's declaration: boards, locked folders only kanban changes, shown at /boards. Each stage
# is a locked folder inside its board, and each conversation filed there a card the agent and the
# user both move. Boards and cards live in its own database.
{ lib, ... }:

{
  contribs.kanban = { config, ... }: {
    options = {
      stages = lib.mkOption {
        type = lib.types.nonEmptyListOf lib.types.nonEmptyStr;
        default = [ "Design" "In progress" "Review" "Done" ];
        description = ''
          The stages a new board starts with, in order. Each stage is a folder inside the
          board's folder, and the user can add, rename, reorder or delete a board's stages
          on the board.
        '';
      };
      staleAfter = lib.mkOption {
        type = lib.types.ints.positive;
        default = 30;
        description = "Minutes after which an untouched card gets one end-of-run reminder to update it.";
      };
    };

    config = {
      src = ./.;

      db = {
        enable = true;
        tables.kanban_cards = { };
        tables.kanban_boards = { };
        tables.kanban_stages = { };
        tables.kanban_blockers = { };
        tables.kanban_tags = { };
        tables.kanban_card_tags = { };
        tables.kanban_card_details = { };
        tables.kanban_skills = { };
        tables.kanban_gates = { };
        tables.kanban_gate_results = { };
      };

      services.broker = {
        enable = true;
        pythonDeps = ps: [ ps.aiosqlite ];
        env = {
          KANBAN_ENABLED = "true";
          KANBAN_STAGES = builtins.toJSON config.stages;
          KANBAN_STALE_AFTER_SECONDS = toString (config.staleAfter * 60);
        };
      };

      skills."kanban.md" = ./skills/kanban.md;

      # The skills the user wrote on the conversation's board (Edit board), as `board-<name>`.
      agent.skillProviders.board = {
        command = "agent-broker kanban/skills -f";
        timeout = 20;
        wait = 5;
        description = "The skills written on the board this conversation is filed on.";
      };

      ui.views.boards = {
        label = "Boards";
        entry = "ui/Boards.tsx";
        api = true;
      };

      agent.hooks = {
        session-start = {
          event = "SessionStart";
          when = "filed";
          userCanDisable = true;
          description = "Tell the agent its card's column when a board conversation starts.";
          command = builtins.readFile ./hooks/session-start.sh;
        };
        prompt-submit = {
          event = "UserPromptSubmit";
          when = "filed";
          userCanDisable = true;
          description = "Remind the agent of its card's column with each message.";
          command = builtins.readFile ./hooks/prompt-submit.sh;
        };
        gate = {
          event = "PreToolUse";
          # Claude's mcp__scooter-broker__kanban_set_status, or goose's title for it.
          matcher = ".*[Kk]anban[ _]?[Ss]et[ _]?[Ss]tatus.*";
          when = "filed";
          # The stage's command gates (tests) run here, each up to its own timeout.
          timeout = 3600;
          description = "Run a stage's command gates (e.g. the tests) before the agent moves its card on.";
          command = builtins.readFile ./hooks/gate.sh;
        };
        stop = {
          event = "Stop";
          when = "filed";
          userCanDisable = true;
          description = "Once per run, ask the agent to set its card's status unless it did this run.";
          command = builtins.readFile ./hooks/stop.sh;
        };
      };
    };
  };
}
