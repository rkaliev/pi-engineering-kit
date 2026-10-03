export type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export type Logger = Record<Level, (msg: string, fields?: Record<string, unknown>) => void>;

/** JSON lines, one per event; events below `level` are dropped. */
export function createLogger(level: Level, write: (line: string) => void = console.log): Logger {
  const make =
    (at: Level) =>
    (msg: string, fields: Record<string, unknown> = {}): void => {
      if (order[at] >= order[level]) write(JSON.stringify({ level: at, msg, ...fields }));
    };
  return { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error") };
}

/**
 * Log fields for a failed request. A 4xx, and a Postgres data exception (class 22), carry type (and code) only:
 * parser, validation and driver messages quote the input (V8's JSON.parse error includes the body), so message
 * and stack stay out of the logs.
 */
export function requestErrorFields(err: unknown, status: number): Record<string, unknown> {
  const e = (err ?? {}) as { type?: unknown; name?: unknown; message?: unknown; stack?: unknown; code?: unknown };
  if (status < 500) return { status, type: typeof e.type === "string" ? e.type : e.name };
  // Postgres data exceptions (class 22, such as 22P02) quote the offending value in the message.
  if (typeof e.code === "string" && e.code.startsWith("22")) return { status, type: e.name, code: e.code };
  return { status, name: e.name, message: e.message ?? String(err), stack: e.stack };
}

export function logRequestError(log: Logger, err: unknown, status: number): void {
  if (status >= 500) log.error("request failed", requestErrorFields(err, status));
  else log.warn("request rejected", requestErrorFields(err, status));
}
