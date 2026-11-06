-- Copy each owner's stars into their new Starred folder.
INSERT INTO "conversation_folders" ("id", "owner", "kind", "name", "position", "created_at")
SELECT gen_random_uuid()::text, o.owner, 'starred', 'Starred', 0,
       (extract(epoch FROM now()) * 1000)::bigint
FROM (SELECT DISTINCT COALESCE("owner", '') AS owner
      FROM "conversations" WHERE "starred" AND "parent_id" IS NULL) o;

INSERT INTO "user_conversation_metadata" ("owner", "conversation_id", "folder_id")
SELECT f."owner", c."id", f."id"
FROM "conversations" c
JOIN "conversation_folders" f ON f."kind" = 'starred' AND f."owner" = COALESCE(c."owner", '')
WHERE c."starred" AND c."parent_id" IS NULL;

-- LIVE FOLDER PUSH: notify only the owner; Atlas cannot diff triggers.
CREATE FUNCTION "conversation_folders_notify"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('conversation_folders_changed',
    json_build_object('owner', COALESCE(NEW.owner, OLD.owner))::text);
  RETURN NULL; -- AFTER trigger: the return value is ignored.
END;
$$;

CREATE TRIGGER "conversation_folders_notify"
  AFTER INSERT OR UPDATE OR DELETE ON "conversation_folders"
  FOR EACH ROW EXECUTE FUNCTION "conversation_folders_notify"();

CREATE TRIGGER "user_conversation_metadata_notify"
  AFTER INSERT OR UPDATE OR DELETE ON "user_conversation_metadata"
  FOR EACH ROW EXECUTE FUNCTION "conversation_folders_notify"();
