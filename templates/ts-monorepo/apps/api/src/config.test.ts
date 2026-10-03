import assert from "node:assert/strict";
import { test } from "vitest";
import { loadConfig } from "./config.ts";

const base = { DATABASE_URL: "postgres://localhost/app" };

test("config fails and names the missing DATABASE_URL", () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
});

test("config applies defaults for every operational value", () => {
  const config = loadConfig(base);
  assert.equal(config.PORT, 3000);
  assert.equal(config.LOG_LEVEL, "info");
  assert.equal(config.DB_STATEMENT_TIMEOUT_MS, 5000);
  assert.equal(config.DB_LOCK_TIMEOUT_MS, 2000);
  assert.equal(config.DB_POOL_MAX, 10);
  assert.equal(config.DB_IDLE_TIMEOUT_MS, 30_000);
  assert.equal(config.DB_CONNECT_TIMEOUT_MS, 5000);
  assert.equal(config.SHUTDOWN_TIMEOUT_MS, 10_000);
});

test("config parses numbers from strings", () => {
  const config = loadConfig({ ...base, PORT: "4000", DB_LOCK_TIMEOUT_MS: "300" });
  assert.equal(config.PORT, 4000);
  assert.equal(config.DB_LOCK_TIMEOUT_MS, 300);
});

test("config rejects text, zero and negative values and names the key", () => {
  for (const bad of ["abc", "0", "-5", "1.5"]) {
    assert.throws(() => loadConfig({ ...base, DB_STATEMENT_TIMEOUT_MS: bad }), /DB_STATEMENT_TIMEOUT_MS/, bad);
  }
});

test("an empty value means the default, not zero", () => {
  const config = loadConfig({ ...base, DB_POOL_MAX: "", SHUTDOWN_TIMEOUT_MS: "" });
  assert.equal(config.DB_POOL_MAX, 10);
  assert.equal(config.SHUTDOWN_TIMEOUT_MS, 10_000);
});
