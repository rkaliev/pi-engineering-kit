import "./marker.ts";
import { readdirSync } from "node:fs";
import { sql, type Kysely } from "kysely";
import type { DB } from "./generated/types.ts";

/** Names of the migration folders this build ships, oldest first. */
export function shippedMigrations(): string[] {
  const dir = new URL("../prisma/migrations/", import.meta.url);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Required migrations that are not applied. Applied ones that are not required (a newer deploy) are fine. */
export function missingMigrations(required: string[], applied: string[]): string[] {
  const have = new Set(applied);
  return required.filter((name) => !have.has(name));
}

/** True when every required migration finished and was not rolled back. Throws when the table is absent. */
export async function schemaReady(db: Kysely<DB>, required: string[]): Promise<boolean> {
  const { rows } = await sql<{ migration_name: string }>`
    select migration_name from _prisma_migrations
    where finished_at is not null and rolled_back_at is null`.execute(db);
  return missingMigrations(required, rows.map((row) => row.migration_name)).length === 0;
}
