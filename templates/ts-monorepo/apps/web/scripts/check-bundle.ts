// Fails the build when server-only code reached the browser bundle.
// The marker string is exported by @repo/db (packages/db/src/marker.ts); a db test keeps the two equal.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const marker = "repo-db-server-only-marker";
const dist = new URL("../dist", import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const all = files(dist);
if (all.length === 0) {
  console.error("check-bundle: dist/ is empty, run vite build first");
  process.exit(1);
}
const leaked = all.filter((file) => readFileSync(file, "utf8").includes(marker));
if (leaked.length > 0) {
  console.error(`check-bundle: server-only code is in the browser bundle:\n${leaked.join("\n")}`);
  process.exit(1);
}
console.log(`check-bundle: ${all.length} files, no server-only code`);
