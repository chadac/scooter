-- atlas:txmode none

-- Concurrently, so the build never blocks appends.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversation_events_run_markers" ON "conversation_events" ("conversation_id", "seq") WHERE ((event ->> 'type'::text) = ANY (ARRAY['RUN_STARTED'::text, 'RUN_FINISHED'::text, 'RUN_ERROR'::text, 'CANCEL_REQUESTED'::text]));
