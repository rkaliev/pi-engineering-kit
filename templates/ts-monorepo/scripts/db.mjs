// Local database: `node scripts/db.mjs up|down`. Reads the Postgres major from .postgres-version
// and hands it to docker compose as POSTGRES_MAJOR. No shell, so it runs the same on every OS.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const commands = { up: ["up", "-d", "--wait", "postgres"], down: ["down"] };
const action = process.argv[2];
if (!(action in commands) || process.argv.length > 3) {
  console.error("Usage: node scripts/db.mjs up|down");
  process.exit(2);
}

let major;
try {
  major = readFileSync(join(root, ".postgres-version"), "utf8").trim();
} catch {
  console.error(".postgres-version is missing: it holds the Postgres major, one positive integer");
  process.exit(1);
}
if (!/^[1-9]\d*$/.test(major)) {
  console.error(`.postgres-version must hold one positive integer, found "${major}"`);
  process.exit(1);
}

const result = spawnSync("docker", ["compose", ...commands[action]], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, POSTGRES_MAJOR: major },
});
if (result.error) {
  console.error(`docker did not start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
