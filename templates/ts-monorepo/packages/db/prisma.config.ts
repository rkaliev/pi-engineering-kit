import { defineConfig } from "prisma/config";

// Prisma owns the schema and migrations only; queries go through Kysely.
// `generate` needs no database, so a missing URL must not fail it; `migrate` fails on an empty one.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
