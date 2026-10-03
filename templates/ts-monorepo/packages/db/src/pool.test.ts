import assert from "node:assert/strict";
import { test } from "vitest";
import { poolConfig } from "./pool.ts";

const settings = {
  DATABASE_URL: "postgres://localhost/app",
  DB_STATEMENT_TIMEOUT_MS: 800,
  DB_LOCK_TIMEOUT_MS: 300,
  DB_POOL_MAX: 4,
  DB_IDLE_TIMEOUT_MS: 1000,
  DB_CONNECT_TIMEOUT_MS: 2000,
};

test("pool carries the timeouts and sizes it is given", () => {
  const config = poolConfig(settings);
  assert.equal(config.connectionString, "postgres://localhost/app");
  assert.equal(config.statement_timeout, 800);
  assert.equal(config.lock_timeout, 300);
  assert.equal(config.max, 4);
  assert.equal(config.idleTimeoutMillis, 1000);
  assert.equal(config.connectionTimeoutMillis, 2000);
});
