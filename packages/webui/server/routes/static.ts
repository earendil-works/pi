import express from "express";
import * as fs from "node:fs";
import * as path from "node:path";

export function mountStatic(app: express.Express, distPath: string): void {
  // Mount express.static for real files (if dist exists)
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath, { index: false }));
  }

  // SPA fallback: any non-/api, non-/ws GET → serve index.html
  app.get(/^\/(?!api|ws).*/, (req, res) => {
    const indexPath = path.join(distPath, "index.html");
    if (!fs.existsSync(indexPath)) {
      res.status(404).type("text/plain").send("Web build not found. Run npm run build first.");
      return;
    }
    res.sendFile(indexPath);
  });
}
