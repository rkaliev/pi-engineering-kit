import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";

// Prisma 7 does not read .env itself; load the repo's file when there is one (CI sets the variable).
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Prisma owns the schema and migrations only; queries go through Kysely.
// `generate` needs no database, so a missing URL must not fail it; `migrate` fails on an empty one.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
