import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "vitest";
import { createApp, type AppDeps } from "./app.ts";
import { createLogger, logRequestError } from "./log.ts";

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
        throw Object.assign(new Error("no such account 42"), { status: 404, expose: true });
      });
      app.get("/odd", () => {
        throw Object.assign(new Error("teapot"), { statusCode: 418, expose: true });
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

test("a status on an error that does not expose itself is a 500, and its message stays out of the log", async () => {
  const lines: string[] = [];
  const log = createLogger("debug", (line) => lines.push(line));
  const seen: number[] = [];
  const base = await start({
    onError: (err, status) => {
      seen.push(status);
      logRequestError(log, err, status);
    },
    routes: (app) => {
      app.get("/auth", () => {
        throw Object.assign(new Error("token for ada@example.com rejected"), { status: 401 });
      });
    },
  });
  const res = await fetch(`${base}/auth`);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "internal" });
  assert.deepEqual(seen, [500]);
  assert.doesNotMatch(lines[0] ?? "", /ada@example\.com/);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    level: "error",
    msg: "request failed",
    status: 500,
    errorStatus: 401,
    type: "Error",
  });
});

test("a malformed path parameter is a 400, and the raw value stays out of the log", async () => {
  const lines: string[] = [];
  const log = createLogger("debug", (line) => lines.push(line));
  const base = await start({
    onError: (err, status) => logRequestError(log, err, status),
    routes: (app) => {
      app.get("/x/:id", (req, res) => {
        res.json({ id: req.params["id"] });
      });
    },
  });
  const res = await fetch(`${base}/x/%E0%A4%A`);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "bad_request" });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0] ?? "", /%E0/);
  assert.equal(JSON.parse(lines[0] ?? "").level, "warn");
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

test("a 4xx log carries status and type only: a rejected body never reaches the logs", async () => {
  const lines: string[] = [];
  const log = createLogger("debug", (line) => lines.push(line));
  let raw = "";
  const base = await start({
    onError: (err, status) => {
      raw = (err as Error).message;
      logRequestError(log, err, status);
    },
    routes: (app) => {
      app.post("/echo", (req, res) => {
        res.json(req.body);
      });
    },
  });
  const res = await fetch(`${base}/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"password": hunter2}',
  });
  assert.equal(res.status, 400);
  assert.match(raw, /hunter2/, "premise: the parser's own message quotes the body");
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0] ?? "", /hunter2/);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    level: "warn",
    msg: "request rejected",
    status: 400,
    errorStatus: 400,
    type: "entity.parse.failed",
  });
});

test("a 500 log keeps the name, message and stack", async () => {
  const lines: string[] = [];
  const log = createLogger("debug", (line) => lines.push(line));
  const base = await start({
    onError: (err, status) => logRequestError(log, err, status),
    routes: (app) => {
      app.get("/boom", () => {
        throw new TypeError("disk on fire");
      });
    },
  });
  assert.equal((await fetch(`${base}/boom`)).status, 500);
  const entry = JSON.parse(lines[0] ?? "");
  assert.equal(entry.level, "error");
  assert.equal(entry.name, "TypeError");
  assert.equal(entry.message, "disk on fire");
  assert.match(entry.stack, /disk on fire/);
});

test("an error after the response started is logged once as a 500, and the connection is aborted", async () => {
  const statuses: number[] = [];
  const base = await start({
    onError: (_err, status) => {
      statuses.push(status);
    },
    routes: (app) => {
      app.get("/half", (_req, res) => {
        res.write("partial");
        throw new Error("late failure");
      });
    },
  });
  let text = "aborted";
  try {
    text = await (await fetch(`${base}/half`)).text();
  } catch {
    // The default handler closes the connection: an aborted body is the expected outcome.
  }
  assert.doesNotMatch(text, /internal/);
  assert.deepEqual(statuses, [500]);
});

test("a Postgres data-exception error logs its type and code only, never the quoted input", async () => {
  const lines: string[] = [];
  const log = createLogger("debug", (line) => lines.push(line));
  const base = await start({
    onError: (err, status) => logRequestError(log, err, status),
    routes: (app) => {
      app.get("/q", () => {
        throw Object.assign(new Error('invalid input syntax for type bigint: "hunter2"'), { code: "22P02" });
      });
    },
  });
  assert.equal((await fetch(`${base}/q`)).status, 500);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0] ?? "", /hunter2/);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), { level: "error", msg: "request failed", status: 500, type: "Error", code: "22P02" });
});
