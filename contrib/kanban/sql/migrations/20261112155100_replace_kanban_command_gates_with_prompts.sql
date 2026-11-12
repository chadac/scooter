-- A gate now asks the card's agent to do something and answer, instead of running a
-- script in its sandbox: each command gate becomes a prompt saying what the script did.
-- Modify "kanban_gates" table
ALTER TABLE "kanban_gates" ADD COLUMN "prompt" text NOT NULL DEFAULT '', ADD COLUMN "skill_id" character varying NOT NULL DEFAULT '';
UPDATE "kanban_gates" SET "kind" = 'prompt', "prompt" =
  'Run `' || "command" || '` in /workspace/' || "workdir"
  || CASE WHEN "clean" THEN ' on a clean checkout of your last commit' ELSE '' END
  || '; it passes when it exits 0 within ' || "timeout_seconds" || 's.'
  WHERE "kind" = 'command';
ALTER TABLE "kanban_gates" DROP COLUMN "command", DROP COLUMN "workdir", DROP COLUMN "clean", DROP COLUMN "timeout_seconds";
-- Modify "kanban_gate_results" table
ALTER TABLE "kanban_gate_results" DROP COLUMN "commit";
