import express from "express";

export type AppDeps = {
  /** Resolves true when the service can take traffic (for example, the database answers). */
  ready: () => Promise<boolean>;
};

export function createApp(deps: AppDeps): express.Express {
  const app = express();

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/readyz", async (_req, res) => {
    const ok = await deps.ready().catch(() => false);
    res.status(ok ? 200 : 503).json({ status: ok ? "ready" : "unavailable" });
  });

  return app;
}
