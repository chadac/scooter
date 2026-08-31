/**
 * @scooter/schema — the generated Drizzle schema for Scooter's shared databases.
 *
 * Tables are exposed under one namespace per database (they are physically
 * separate databases; `remote_agents` even exists in two with different columns).
 * Import only the database you own:
 *
 *   import { webhooks, assertDatabase } from "@scooter/schema";
 *   await assertDatabase(pool, "webhooks");
 *   await db.select().from(webhooks.userIdentity);
 *
 * The per-database modules are GENERATED from lib/sql/<db>/schema.sql by
 * `just db-generate` — do not hand-edit them. guard.ts and this file are not.
 */

export * as webhooks from "./webhooks.js";
export * as scheduler from "./scheduler.js";
export * as broker from "./broker.js";
export * as byoc from "./byoc.js";
export { assertDatabase, DATABASES, type Database, type Queryable } from "./guard.js";
