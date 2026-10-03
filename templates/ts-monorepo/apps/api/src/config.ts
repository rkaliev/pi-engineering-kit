import { z } from "zod";

// An empty value (`KEY=` in .env) means "not set", so the default applies; it never becomes 0.
const unset = (value: unknown): unknown => (value === "" ? undefined : value);
const positive = (fallback: number) =>
  z.preprocess(unset, z.coerce.number().int().positive().default(fallback));

// The only place that reads env, and the owner of every operational value.
// Secrets have no default: a missing one stops startup.
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.preprocess(unset, z.coerce.number().int().min(0).max(65535).default(3000)),
  LOG_LEVEL: z.preprocess(unset, z.enum(["debug", "info", "warn", "error"]).default("info")),
  DB_STATEMENT_TIMEOUT_MS: positive(5000),
  DB_LOCK_TIMEOUT_MS: positive(2000),
  DB_POOL_MAX: positive(10),
  DB_IDLE_TIMEOUT_MS: positive(30_000),
  DB_CONNECT_TIMEOUT_MS: positive(5000),
  SHUTDOWN_TIMEOUT_MS: positive(10_000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid configuration: ${keys.join(", ")}`);
  }
  return result.data;
}
