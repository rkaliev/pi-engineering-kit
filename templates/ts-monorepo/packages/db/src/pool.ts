import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { DB } from "./generated/types.ts";

// node-postgres returns int8 as a string; money and ids are bigint (see the payments-and-money skill).
pg.types.setTypeParser(pg.types.builtins.INT8, BigInt);

export type DbEnv = {
  DATABASE_URL: string;
  DB_STATEMENT_TIMEOUT_MS?: string | undefined;
  DB_LOCK_TIMEOUT_MS?: string | undefined;
};

/** Pure: the same env always gives the same pool settings. Timeouts apply to every pooled connection. */
export function poolConfig(env: DbEnv): pg.PoolConfig {
  return {
    connectionString: env.DATABASE_URL,
    statement_timeout: Number(env.DB_STATEMENT_TIMEOUT_MS ?? 5000),
    lock_timeout: Number(env.DB_LOCK_TIMEOUT_MS ?? 2000),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5000,
  };
}

export function createDb(env: DbEnv): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool(poolConfig(env)) }) });
}

/** True when the database answers a trivial query; for readiness checks. */
export async function ping(db: Kysely<DB>): Promise<boolean> {
  await sql`select 1`.execute(db);
  return true;
}
