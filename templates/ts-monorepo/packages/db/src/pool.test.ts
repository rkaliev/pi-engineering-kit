import assert from "node:assert/strict";
import { test } from "vitest";
import { poolConfig } from "./pool.ts";

test("pool sets statement and lock timeouts by default", () => {
  const config = poolConfig({ DATABASE_URL: "postgres://localhost/app" });
  assert.equal(config.connectionString, "postgres://localhost/app");
  assert.equal(config.statement_timeout, 5000);
  assert.equal(config.lock_timeout, 2000);
});

test("pool timeouts come from the environment", () => {
  const config = poolConfig({
    DATABASE_URL: "postgres://localhost/app",
    DB_STATEMENT_TIMEOUT_MS: "800",
    DB_LOCK_TIMEOUT_MS: "300",
  });
  assert.equal(config.statement_timeout, 800);
  assert.equal(config.lock_timeout, 300);
});
