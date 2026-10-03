import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "vitest";
import { missingMigrations, shippedMigrations } from "./schema.ts";
import { SERVER_ONLY_MARKER } from "./marker.ts";

test("nothing is missing when every required migration is applied; newer extras are fine", () => {
  assert.deepEqual(missingMigrations(["a", "b"], ["a", "b", "c"]), []);
});

test("missing migrations are listed in the required order", () => {
  assert.deepEqual(missingMigrations(["a", "b", "c"], ["b"]), ["a", "c"]);
});

test("the shipped migrations are the folders of prisma/migrations", () => {
  assert.ok(shippedMigrations().includes("00000000000000_init"));
});

test("the web bundle check looks for the same marker", () => {
  const script = readFileSync(new URL("../../../apps/web/scripts/check-bundle.ts", import.meta.url), "utf8");
  assert.ok(script.includes(SERVER_ONLY_MARKER));
});

test("every database module carries the server-only marker", () => {
  const files = readdirSync(new URL("./", import.meta.url)).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "marker.ts",
  );
  assert.ok(files.length >= 3, "expected the db modules");
  for (const file of files) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.match(source, /^import "\.\/marker\.ts";$/m, file);
  }
});
