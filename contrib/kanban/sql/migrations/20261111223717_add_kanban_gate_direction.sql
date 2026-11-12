-- Modify "kanban_gates" table
ALTER TABLE "kanban_gates" ADD COLUMN "direction" character varying NOT NULL DEFAULT 'leave';
