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
