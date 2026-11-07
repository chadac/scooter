/**
 * BYOC controller entrypoint: configuration, then the network shell (shell.ts). It runs as
 * a single replica: one process owns every container socket, a restart drops them, and the
 * containers reconnect on their own.
 */

import { startController } from "./shell.js";
import {
  createPgSessionStore,
  createMemorySessionStore,
  createPgDeviceStore,
  createMemoryDeviceStore,
} from "./sessionStore.js";

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_PORT = process.env.PUBLIC_PORT ? Number(process.env.PUBLIC_PORT) : undefined;
const SECRET = process.env.BYOC_JOIN_SECRET ?? "";
// Assemble the DSN from parts, since postgres-init writes only a `password` secret; DATABASE_URL is still honoured.
const DSN =
  process.env.DATABASE_URL ??
  (process.env.DB_HOST
    ? `postgresql://${process.env.DB_USER ?? "byoc"}:${encodeURIComponent(process.env.DB_PASSWORD ?? "")}` +
      `@${process.env.DB_HOST}:${process.env.DB_PORT ?? "5432"}/${process.env.DB_NAME ?? "byoc"}` +
      (process.env.DB_SSLMODE ? `?sslmode=${process.env.DB_SSLMODE}` : "")
    : "");

if (!SECRET) {
  console.error("[byoc] BYOC_JOIN_SECRET is required — refusing to start without a signing key");
  process.exit(1);
}

// Durable owner->session mapping when a DSN is configured, in-memory otherwise; the socket is always in-memory.
const store = DSN ? createPgSessionStore({ dsn: DSN }) : createMemorySessionStore();
if (!DSN) console.warn("[byoc] no DATABASE_URL — owner->session mapping will NOT survive a restart");

const deviceStore = DSN ? createPgDeviceStore({ dsn: DSN }) : createMemoryDeviceStore();

const controller = await startController({ port: PORT, publicPort: PUBLIC_PORT, secret: SECRET, store, deviceStore });

const shutdown = () => {
  console.log("[byoc] shutting down");
  void controller.close();
  void store.close();
  void deviceStore.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
