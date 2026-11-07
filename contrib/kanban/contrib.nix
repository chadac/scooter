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
