import { sql } from "kysely";
import { createDb } from "@repo/db";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig(process.env);
const db = createDb(config);

const app = createApp({
  ready: async () => {
    await sql`select 1`.execute(db);
    return true;
  },
});

const server = app.listen(config.PORT, () => {
  console.log(JSON.stringify({ level: "info", msg: "listening", port: config.PORT }));
});

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", msg: "shutting down", signal }));
  // Stop accepting, let in-flight requests finish, then release the pool.
  server.close(() => {
    db.destroy().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
