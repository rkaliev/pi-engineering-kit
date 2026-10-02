import express from "express";

export type AppDeps = {
  /** Resolves true when the service can take traffic (the database answers and its schema is current). */
  ready: () => Promise<boolean>;
  /** Called with every error that reaches the final handler. The client only sees a generic 500. */
  onError: (err: unknown) => void;
  /** Mounts the product's routes; they run before the error handler. */
  routes?: (app: express.Express) => void;
};

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  // JSON has no bigint: send ids and money amounts as strings.
  app.set("json replacer", (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/readyz", async (_req, res) => {
    const ok = await deps.ready().catch(() => false);
    res.status(ok ? 200 : 503).json({ status: ok ? "ready" : "unavailable" });
  });

  deps.routes?.(app);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    deps.onError(err);
    res.status(500).json({ error: "internal" });
  });

  return app;
}
