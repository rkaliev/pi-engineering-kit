import assert from "node:assert/strict";
import { test } from "vitest";
import { loadConfig } from "./config.ts";

test("config fails and names the missing DATABASE_URL", () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
});

test("config parses a valid environment and applies defaults", () => {
  const config = loadConfig({ DATABASE_URL: "postgres://localhost/app", PORT: "4000" });
  assert.equal(config.PORT, 4000);
  assert.equal(config.LOG_LEVEL, "info");
});
