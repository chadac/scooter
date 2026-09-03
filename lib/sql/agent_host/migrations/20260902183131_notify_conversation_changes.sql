-- Live conversation-list push: NOTIFY on conversations changes so the conversation-router can
-- serve GET /conversations/events by LISTENing on channel 'conversations_changed' instead of
-- fanning SSE out to every agent-host pod. This is the SOURCE OF TRUTH for the trigger:
-- Atlas Community does not diff FUNCTION/TRIGGER objects, so it cannot live in schema.sql (see
-- the note there), and production is built by replaying these migrations.
--
-- Payload is {id, op} only (well under NOTIFY's 8000-byte limit); the router re-reads the row
-- and joins the CR + links to build the frame — the row is authoritative, not the payload.
--
-- The UPDATE trigger is scoped to the sidebar-visible fields (title/starred/user_titled/owner).
-- last_activity_at is bumped on every prompt and on throttled proxy traffic; pushing those would
-- be a firehose the list ordering does not need live (the 10s poll reconciles activity order).
-- This mirrors agent-host's old emitChange, which fired on new/title/star only. Keep the WHEN
-- columns in sync with the router's assembleList — those are the only two places that must agree
-- on which changes push.
CREATE FUNCTION "conversations_notify"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('conversations_changed',
    json_build_object('id', COALESCE(NEW.id, OLD.id),
                      'op', CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END)::text);
  RETURN NULL; -- AFTER trigger: the return value is ignored.
END;
$$;

CREATE TRIGGER "conversations_notify_ins_del" AFTER INSERT OR DELETE ON "conversations"
  FOR EACH ROW EXECUTE FUNCTION "conversations_notify"();

CREATE TRIGGER "conversations_notify_upd" AFTER UPDATE ON "conversations"
  FOR EACH ROW WHEN (
    OLD."title"       IS DISTINCT FROM NEW."title"       OR
    OLD."starred"     IS DISTINCT FROM NEW."starred"     OR
    OLD."user_titled" IS DISTINCT FROM NEW."user_titled" OR
    OLD."owner"       IS DISTINCT FROM NEW."owner"
  ) EXECUTE FUNCTION "conversations_notify"();
