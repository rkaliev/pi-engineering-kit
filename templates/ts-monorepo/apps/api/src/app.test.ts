import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "vitest";
import { createApp, type AppDeps } from "./app.ts";

let close: (() => void) | undefined;
afterEach(() => close?.());

function start(deps: Partial<AppDeps> = {}): Promise<string> {
  return new Promise((resolve) => {
    const server = createApp({ ready: async () => true, onError: () => {}, ...deps }).listen(0, () => {
      close = () => server.close();
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

test("healthz answers 200 ok and hides the framework", async () => {
  const base = await start();
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("readyz is 200 when ready and 503 when not or when the check throws", async () => {
  assert.equal((await fetch(`${await start()}/readyz`)).status, 200);
  close?.();
  assert.equal((await fetch(`${await start({ ready: async () => false })}/readyz`)).status, 503);
  close?.();
  assert.equal(
    (await fetch(`${await start({ ready: async () => { throw new Error("db down"); } })}/readyz`)).status,
    503,
  );
});

test("an unhandled error is a generic 500 without a stack, and is reported", async () => {
  const seen: unknown[] = [];
  const base = await start({
    onError: (err) => seen.push(err),
    routes: (app) => {
      app.get("/boom", () => {
        throw new Error("secret detail");
      });
    },
  });
  const res = await fetch(`${base}/boom`);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "internal" });
  assert.equal(seen.length, 1);
});

test("a malformed JSON body is a 400 bad_request, reported with its status", async () => {
  const seen: number[] = [];
  const base = await start({
    onError: (_err, status) => seen.push(status),
    routes: (app) => {
      app.post("/echo", (req, res) => {
        res.json(req.body);
      });
    },
  });
  const res = await fetch(`${base}/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "bad_request" });
  assert.deepEqual(seen, [400]);
});

test("a 4xx error keeps its class with a generic message; a 5xx stays internal", async () => {
  const seen: number[] = [];
  const base = await start({
    onError: (_err, status) => seen.push(status),
    routes: (app) => {
      app.get("/missing", () => {
        throw Object.assign(new Error("no such account 42"), { status: 404 });
      });
      app.get("/odd", () => {
        throw Object.assign(new Error("teapot"), { statusCode: 418 });
      });
      app.get("/bad-gateway", () => {
        throw Object.assign(new Error("upstream"), { status: 502 });
      });
    },
  });
  const missing = await fetch(`${base}/missing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not_found" });
  const odd = await fetch(`${base}/odd`);
  assert.equal(odd.status, 418);
  assert.deepEqual(await odd.json(), { error: "client_error" });
  const gateway = await fetch(`${base}/bad-gateway`);
  assert.equal(gateway.status, 500);
  assert.deepEqual(await gateway.json(), { error: "internal" });
  assert.deepEqual(seen, [404, 418, 500]);
});

test("bigint values serialise as strings", async () => {
  const base = await start({
    routes: (app) => {
      app.get("/n", (_req, res) => {
        res.json({ amount: 12345678901234567890n });
      });
    },
  });
  assert.deepEqual(await (await fetch(`${base}/n`)).json(), { amount: "12345678901234567890" });
});
