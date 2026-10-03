// Reverts the latest applied migration in one transaction: checks the history, runs its down.sql,
// marks the history row rolled back. Prisma has no down migrations, and `migrate resolve --rolled-back`
// only accepts failed ones, so the row is updated here; `migrate deploy` re-applies a rolled-back migration.
// down.sql must not contain COMMIT or statements that cannot run inside a transaction.
// The session has a 10 s statement timeout: a down.sql that rewrites a large table starts with its own
// `SET LOCAL statement_timeout = …`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = fileURLToPath(new URL("..", import.meta.url));
// Same as prisma.config.ts: the repo's .env when there is one; variables already set win.
const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

function fail(message: string): never {
  console.error(`migrate-down: ${message}`);
  process.exit(1);
}

const name = process.argv[2];
if (!name || !/^[0-9]{14}_[A-Za-z0-9_]+$/.test(name)) fail("usage: pnpm --filter @repo/db migrate:down <migration-name>");
const downFile = join(root, "prisma/migrations", name, "down.sql");
if (!existsSync(downFile)) fail(`${name} has no down.sql`);
if (!process.env.DATABASE_URL) fail("DATABASE_URL is empty");
const down = readFileSync(downFile, "utf8");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
await client.connect();
try {
  await client.query("SET statement_timeout = '10s'");
  await client.query("SET lock_timeout = '5s'");
  await client.query("BEGIN");
  await client.query("LOCK TABLE _prisma_migrations IN EXCLUSIVE MODE");

  const unresolved = await client.query(
    "select migration_name from _prisma_migrations where finished_at is null and rolled_back_at is null",
  );
  if (unresolved.rowCount) fail(`unresolved failed migration: ${unresolved.rows.map((r) => r.migration_name).join(", ")}`);

  const latest = await client.query<{ migration_name: string }>(
    `select migration_name from _prisma_migrations
     where rolled_back_at is null order by finished_at desc limit 1`,
  );
  const current = latest.rows[0]?.migration_name;
  if (current !== name) fail(`only the latest applied migration can be reverted (latest: ${current ?? "none"}, asked: ${name})`);

  await client.query(down);
  await client.query(
    "update _prisma_migrations set rolled_back_at = now() where migration_name = $1 and rolled_back_at is null",
    [name],
  );
  await client.query("COMMIT");
  console.log(`migrate-down: reverted ${name}`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
