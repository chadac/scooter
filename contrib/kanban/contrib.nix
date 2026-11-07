# kanban's declaration: boards, locked folders only kanban changes, shown at /boards, each conversation a
# card whose column the agent and the user both move. Boards and cards live in its own database.
{ lib, ... }:

{
  contribs.kanban = { config, ... }: {
    options = {
      columns = lib.mkOption {
        type = lib.types.listOf (lib.types.submodule {
          options = {
            id = lib.mkOption {
              type = lib.types.strMatching "[a-z][a-z0-9-]{0,39}";
              description = "The column's id, which the agent passes to kanban_set_status.";
            };
            label = lib.mkOption {
              type = lib.types.str;
              description = "The column's heading on the board.";
            };
          };
        });
        default = [
          { id = "design"; label = "Design"; }
          { id = "in-progress"; label = "In progress"; }
          { id = "review"; label = "Review"; }
          { id = "done"; label = "Done"; }
        ];
        description = "Every board's columns, in order. A card with no status shows in the first.";
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
      };

      services.broker = {
        enable = true;
        pythonDeps = ps: [ ps.aiosqlite ];
        env = {
          KANBAN_ENABLED = "true";
          KANBAN_COLUMNS = builtins.toJSON (map (c: { inherit (c) id label; }) config.columns);
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
