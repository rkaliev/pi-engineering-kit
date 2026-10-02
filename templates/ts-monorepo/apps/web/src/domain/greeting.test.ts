import assert from "node:assert/strict";
import { test } from "vitest";
import { greeting } from "./greeting.ts";

test("greeting names the person", () => {
  assert.equal(greeting("  Ada "), "Hello, Ada");
});

test("greeting without a name is plain", () => {
  assert.equal(greeting("   "), "Hello");
});
