import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

test("every shipped migration has a non-empty down.sql", () => {
  for (const name of shippedMigrations()) {
    const down = new URL(`../prisma/migrations/${name}/down.sql`, import.meta.url);
    assert.ok(existsSync(down), `${name} has no down.sql`);
    assert.ok(readFileSync(down, "utf8").trim().length > 0, `${name}/down.sql is empty`);
  }
});

test("the web bundle check looks for the same marker", () => {
  const script = readFileSync(new URL("../../../apps/web/scripts/check-bundle.ts", import.meta.url), "utf8");
  assert.ok(script.includes(SERVER_ONLY_MARKER));
});

function sources(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sources(new URL(`${entry.name}/`, dir));
    const skip = !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || entry.name === "marker.ts";
    return skip ? [] : [new URL(entry.name, dir)];
  });
}

test("every database module, in subfolders too, carries the server-only marker", () => {
  const root = new URL("./", import.meta.url);
  const files = sources(root);
  assert.ok(files.length >= 3, "expected the db modules");
  for (const file of files) {
    // Depth below this folder, never from the absolute path (a project may live under any `src/`).
    const depth = file.href.slice(root.href.length).split("/").length;
    const expected = `import "${depth > 1 ? "../".repeat(depth - 1) : "./"}marker.ts";`;
    assert.ok(readFileSync(file, "utf8").split("\n").includes(expected), file.pathname);
  }
});
