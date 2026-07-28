import express, { type Express } from "express";

export function createApp(): Express {
  const app = express();

  app.use(express.json({ limit: "256kb" }));
  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      service: "delta-account-scout"
    });
  });

  return app;
}
