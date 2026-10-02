import { createDb, ping, schemaReady, shippedMigrations } from "@repo/db";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";

const config = loadConfig(process.env);
const log = createLogger(config.LOG_LEVEL);
const db = createDb(config);
// Ready only when the database answers and has every migration this build ships.
const required = shippedMigrations();

const app = createApp({
  ready: async () => (await ping(db)) && (await schemaReady(db, required)),
  onError: (err) => log.error("unhandled error", { err: err instanceof Error ? err.message : String(err) }),
});

const server = app.listen(config.PORT, () => {
  log.info("listening", { port: config.PORT });
});

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { signal });
  // Stop accepting, let in-flight requests finish, then release the pool.
  server.close(() => {
    db.destroy().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
  setTimeout(() => process.exit(1), config.SHUTDOWN_TIMEOUT_MS).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
