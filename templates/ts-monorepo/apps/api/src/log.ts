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

/** The 4xx status an error carries (`status` or `statusCode`), exposed or not. */
export function clientStatusOf(err: unknown): number | undefined {
  const { status, statusCode } = (err ?? {}) as { status?: unknown; statusCode?: unknown };
  const code = typeof status === "number" ? status : statusCode;
  return typeof code === "number" && code >= 400 && code <= 499 ? code : undefined;
}

/**
 * Log fields for a failed request. An error that carries a 4xx status (exposed or not) logs its type only,
 * with the status sent and its own: parser, validation and routing messages quote the input (V8's JSON.parse
 * error includes the body, Express's includes the raw parameter). A Postgres data exception (class 22) logs
 * type and code only. Any other 5xx keeps name, message and stack.
 */
export function requestErrorFields(err: unknown, status: number): Record<string, unknown> {
  const e = (err ?? {}) as { type?: unknown; name?: unknown; message?: unknown; stack?: unknown; code?: unknown };
  const errorStatus = clientStatusOf(err);
  if (errorStatus !== undefined) return { status, errorStatus, type: typeof e.type === "string" ? e.type : e.name };
  if (typeof e.code === "string" && e.code.startsWith("22")) return { status, type: e.name, code: e.code };
  return { status, name: e.name, message: e.message ?? String(err), stack: e.stack };
}

export function logRequestError(log: Logger, err: unknown, status: number): void {
  if (status >= 500) log.error("request failed", requestErrorFields(err, status));
  else log.warn("request rejected", requestErrorFields(err, status));
}
