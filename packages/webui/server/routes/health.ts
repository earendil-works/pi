import express from "express";
import packageJson from "../../package.json" with { type: "json" };

export function mountHealth(
  app: express.Express,
  deps?: {
    getSessionCount?: () => number;
    startedAt?: number;
  }
): void {
  const getSessionCount = deps?.getSessionCount ?? (() => 0);
  const startedAt = deps?.startedAt ?? Date.now();

  app.get("/api/health", (_req, res) => {
    const uptime = Math.floor((Date.now() - startedAt) / 1000);
    res.json({
      ok: true,
      version: packageJson.version,
      uptime,
      sessions: getSessionCount(),
    });
  });
}
