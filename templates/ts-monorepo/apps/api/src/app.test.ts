import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "vitest";
import { createApp } from "./app.ts";

let close: (() => void) | undefined;
afterEach(() => close?.());

function start(ready: () => Promise<boolean>): Promise<string> {
  return new Promise((resolve) => {
    const server = createApp({ ready }).listen(0, () => {
      close = () => server.close();
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

test("healthz answers 200 ok", async () => {
  const base = await start(async () => true);
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("readyz is 200 when ready and 503 when not", async () => {
  const ready = await start(async () => true);
  assert.equal((await fetch(`${ready}/readyz`)).status, 200);
  close?.();
  const down = await start(async () => false);
  assert.equal((await fetch(`${down}/readyz`)).status, 503);
});
