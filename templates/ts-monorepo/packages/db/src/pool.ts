import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { DB } from "./generated/types.ts";

// node-postgres returns int8 as a string; money and ids are bigint (see the payments-and-money skill).
pg.types.setTypeParser(pg.types.builtins.INT8, BigInt);

export type PoolSettings = {
  DATABASE_URL: string;
  DB_STATEMENT_TIMEOUT_MS: number;
  DB_LOCK_TIMEOUT_MS: number;
  DB_POOL_MAX: number;
  DB_IDLE_TIMEOUT_MS: number;
  DB_CONNECT_TIMEOUT_MS: number;
};

/** Pure: typed values in, pool settings out. The caller's config owns the defaults; nothing here reads env. */
export function poolConfig(settings: PoolSettings): pg.PoolConfig {
  return {
    connectionString: settings.DATABASE_URL,
    statement_timeout: settings.DB_STATEMENT_TIMEOUT_MS,
    lock_timeout: settings.DB_LOCK_TIMEOUT_MS,
    max: settings.DB_POOL_MAX,
    idleTimeoutMillis: settings.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: settings.DB_CONNECT_TIMEOUT_MS,
  };
}

export function createDb(settings: PoolSettings): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool(poolConfig(settings)) }) });
}

/** True when the database answers a trivial query; for readiness checks. */
export async function ping(db: Kysely<DB>): Promise<boolean> {
  await sql`select 1`.execute(db);
  return true;
}
