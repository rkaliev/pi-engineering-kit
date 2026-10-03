import express from "express";

export type AppDeps = {
  /** Resolves true when the service can take traffic (the database answers and its schema is current). */
  ready: () => Promise<boolean>;
  /** Called with every error that reaches the final handler, with the status sent. The client sees only a generic body. */
  onError: (err: unknown, status: number) => void;
  /** Mounts the product's routes; they run before the error handler. */
  routes?: (app: express.Express) => void;
};

const clientErrors: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  422: "unprocessable",
  429: "too_many_requests",
};

/**
 * A 4xx passes through only from an error that marks itself safe to show (`expose: true`, the http-errors
 * and body-parser convention). A bare `status` on any other error is not trusted: it is a 500.
 */
function statusOf(err: unknown): number {
  const { status, statusCode, expose } = (err ?? {}) as { status?: unknown; statusCode?: unknown; expose?: unknown };
  const code = typeof status === "number" ? status : statusCode;
  return expose === true && typeof code === "number" && code >= 400 && code <= 499 ? code : 500;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  // JSON has no bigint: send ids and money amounts as strings.
  app.set("json replacer", (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );

  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/readyz", async (_req, res) => {
    const ok = await deps.ready().catch(() => false);
    res.status(ok ? 200 : 503).json({ status: ok ? "ready" : "unavailable" });
  });

  deps.routes?.(app);

  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    // The response has started: report the failure, then let Express's default handler close the connection.
    if (res.headersSent) {
      deps.onError(err, 500);
      return next(err);
    }
    const status = statusOf(err);
    deps.onError(err, status);
    res.status(status).json({ error: status === 500 ? "internal" : (clientErrors[status] ?? "client_error") });
  });

  return app;
}
