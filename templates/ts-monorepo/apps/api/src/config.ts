import { z } from "zod";

// The only place that reads env. Secrets have no default: a missing one stops startup.
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DB_STATEMENT_TIMEOUT_MS: z.string().optional(),
  DB_LOCK_TIMEOUT_MS: z.string().optional(),
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
