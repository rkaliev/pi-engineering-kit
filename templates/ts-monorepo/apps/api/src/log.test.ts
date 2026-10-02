import assert from "node:assert/strict";
import { test } from "vitest";
import { createLogger } from "./log.ts";

test("the logger writes JSON lines at or above the configured level", () => {
  const lines: string[] = [];
  const log = createLogger("warn", (line) => lines.push(line));
  log.info("quiet");
  log.warn("loud", { code: 7 });
  log.error("louder");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), { level: "warn", msg: "loud", code: 7 });
});
