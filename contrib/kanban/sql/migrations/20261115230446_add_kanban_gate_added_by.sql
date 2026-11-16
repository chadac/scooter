-- Modify "kanban_gates" table
ALTER TABLE "kanban_gates" ADD COLUMN "added_by" character varying NOT NULL DEFAULT 'user';
