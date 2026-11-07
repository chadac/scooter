-- contrib_kanban database — declarative end-state schema (SOURCE OF TRUTH).
--
-- This contrib's OWN database (`contribs.kanban.db`), owned by the broker's role
-- because the store runs inside the broker. Atlas writes ./migrations from this
-- file (`just db-migrate kanban`). The row model in scooter_contrib_kanban/store.py
-- mirrors it, and tests/test_db.py holds the two together.

-- A card's note; its stage is its conversation's folder.
CREATE TABLE "kanban_cards" (
  -- The broker's key for the conversation (Identity.conversation_id).
  "conversation_id" character varying NOT NULL,
  -- Stage folder the position applies to.
  "column_id"       character varying NOT NULL,
  -- Fractional order within the column, so a move rewrites one row.
  "position"        double precision NOT NULL,
  -- The agent's one-line summary of where the work stands.
  "note"            text NOT NULL,
  -- "agent" or "user": who made the last change.
  "updated_by"      character varying NOT NULL,
  -- ISO-8601, like the other broker tables.
  "updated_at"      character varying NOT NULL,
  PRIMARY KEY ("conversation_id")
);

-- Locked folders kanban made as boards.
CREATE TABLE "kanban_boards" (
  -- A conversation folder's id (agent_host.conversation_folders.id, another database).
  "folder_id"  character varying NOT NULL,
  "owner"      character varying NOT NULL,
  "created_at" character varying NOT NULL,
  PRIMARY KEY ("folder_id")
);
CREATE INDEX "ix_kanban_boards_owner" ON "kanban_boards" ("owner");

-- Stages: locked folders inside a board's folder.
CREATE TABLE "kanban_stages" (
  -- The stage's folder id (agent_host.conversation_folders.id, another database).
  "folder_id" character varying NOT NULL,
  -- The board's folder id (kanban_boards.folder_id).
  "board_id"  character varying NOT NULL,
  -- The folder's name; agents name stages by it.
  "name"      character varying NOT NULL,
  -- Board order, the folder's sidebar position too.
  "position"  double precision NOT NULL,
  PRIMARY KEY ("folder_id")
);
CREATE INDEX "ix_kanban_stages_board_id" ON "kanban_stages" ("board_id");

-- A card waits until its blockers reach the last stage.
CREATE TABLE "kanban_blockers" (
  -- The blocked card's key (kanban_cards.conversation_id).
  "conversation_id" character varying NOT NULL,
  -- The blocking card's key.
  "blocker_id"      character varying NOT NULL,
  -- "agent" or "user".
  "created_by"      character varying NOT NULL,
  "created_at"      character varying NOT NULL,
  PRIMARY KEY ("conversation_id", "blocker_id")
);
CREATE INDEX "ix_kanban_blockers_blocker_id" ON "kanban_blockers" ("blocker_id");

-- A board's tags, which the user picks; unique by name, case-insensitively, per board.
CREATE TABLE "kanban_tags" (
  "id"       character varying NOT NULL,
  -- The board's folder id (kanban_boards.folder_id).
  "board_id" character varying NOT NULL,
  "name"     character varying NOT NULL,
  -- A palette key, e.g. "blue" (store.TAG_COLORS).
  "color"    character varying NOT NULL,
  -- Order in the picker and on the card.
  "position" double precision NOT NULL,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_kanban_tags_board_id" ON "kanban_tags" ("board_id");

-- Tags on a card.
CREATE TABLE "kanban_card_tags" (
  -- kanban_cards.conversation_id; a card may be tagged before it has a status.
  "conversation_id" character varying NOT NULL,
  -- kanban_tags.id
  "tag_id"          character varying NOT NULL,
  PRIMARY KEY ("conversation_id", "tag_id")
);
CREATE INDEX "ix_kanban_card_tags_tag_id" ON "kanban_card_tags" ("tag_id");

-- A card's description and priority, apart from kanban_cards so editing them isn't a move.
CREATE TABLE "kanban_card_details" (
  -- kanban_cards.conversation_id; a card may have details before it has a status.
  "conversation_id" character varying NOT NULL,
  -- Markdown, what the card is for.
  "description"     text NOT NULL DEFAULT '',
  -- 0 none, 1 low, 2 medium, 3 high, 4 urgent (store.PRIORITIES).
  "priority"        integer NOT NULL DEFAULT 0,
  -- "agent" or "user".
  "updated_by"      character varying NOT NULL,
  "updated_at"      character varying NOT NULL,
  PRIMARY KEY ("conversation_id")
);
