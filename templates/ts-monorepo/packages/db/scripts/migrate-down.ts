// Reverts the latest applied migration: runs its down.sql, then forgets it in _prisma_migrations,
// both in one batch (one implicit transaction). Prisma has no down migrations, and
// `migrate resolve --rolled-back` only accepts failed ones, so the history row is deleted instead.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = fileURLToPath(new URL("..", import.meta.url));
const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const name = process.argv[2];
if (!name || !/^[0-9]{14}_[A-Za-z0-9_]+$/.test(name)) {
  console.error("usage: pnpm --filter @repo/db migrate:down <migration-name>");
  process.exit(1);
}
const downFile = join(root, "prisma/migrations", name, "down.sql");
if (!existsSync(downFile)) {
  console.error(`migrate-down: ${name} has no down.sql`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("migrate-down: DATABASE_URL is empty");
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let latest: string | undefined;
try {
  const { rows } = await client.query<{ migration_name: string }>(
    `select migration_name from _prisma_migrations
     where finished_at is not null and rolled_back_at is null
     order by migration_name desc limit 1`,
  );
  latest = rows[0]?.migration_name;
} finally {
  await client.end();
}
if (latest !== name) {
  console.error(`migrate-down: only the latest applied migration can be reverted (latest: ${latest ?? "none"}, asked: ${name})`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "migrate-down-"));
try {
  const file = join(dir, "down.sql");
  const forget = `\nDELETE FROM _prisma_migrations WHERE migration_name = '${name}';\n`;
  writeFileSync(file, readFileSync(downFile, "utf8") + forget);
  execFileSync("pnpm", ["exec", "prisma", "db", "execute", "--file", file], { cwd: root, stdio: "inherit" });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`migrate-down: reverted ${name}`);
