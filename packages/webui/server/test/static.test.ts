import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "node:http";
import { AddressInfo } from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_PORT = 18750;

describe("Static File Serving", () => {
  let tempDir: string;
  let otherTempDir: string;
  let mountStatic: (app: express.Express, distPath: string) => void;

  beforeEach(async () => {
    // Create a temp directory with sample dist files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-static-test-"));
    otherTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-static-test-nonexistent-"));

    // Dynamic import to load mountStatic
    const module = await import("../routes/static");
    mountStatic = module.mountStatic;
  });

  afterEach(() => {
    // Clean up temp directories
    try {
      fs.rmSync(tempDir, { recursive: true });
    } catch {}
    try {
      fs.rmSync(otherTempDir, { recursive: true });
    } catch {}
  });

  describe("(a) With real distPath containing index.html and style.css", () => {
    let app: express.Express;
    let server: http.Server;

    beforeEach(() => {
      // Create sample files
      fs.writeFileSync(path.join(tempDir, "index.html"), "<html><body>SPA</body></html>");
      fs.writeFileSync(path.join(tempDir, "style.css"), "body { color: red; }");

      app = express();
      mountStatic(app, tempDir);
      server = app.listen(TEST_PORT);
    });

    afterEach(() => {
      server.close();
    });

    it("GET / returns 200 with content of index.html", async () => {
      const response = await fetch("http://127.0.0.1:" + TEST_PORT + "/");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toBe("<html><body>SPA</body></html>");
    });

    it("GET /style.css returns 200 with content of style.css", async () => {
      const response = await fetch("http://127.0.0.1:" + TEST_PORT + "/style.css");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toBe("body { color: red; }");
    });

    it("GET /some-spa-route returns 200 with content of index.html (SPA fallback)", async () => {
      const response = await fetch("http://127.0.0.1:" + TEST_PORT + "/some-spa-route");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toBe("<html><body>SPA</body></html>");
    });

    it("GET /cron returns 200 with content of index.html (SPA fallback)", async () => {
      const response = await fetch("http://127.0.0.1:" + TEST_PORT + "/cron");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toBe("<html><body>SPA</body></html>");
    });
  });

  describe("(b) With non-existent distPath", () => {
    let app: express.Express;
    let server: http.Server;

    beforeEach(() => {
      app = express();
      mountStatic(app, "/non/existent/path");
      server = app.listen(TEST_PORT + 1);
    });

    afterEach(() => {
      server.close();
    });

    it("GET / returns 404 with 'Web build not found' message", async () => {
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 1) + "/");
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).toBe("Web build not found. Run npm run build first.");
    });
  });

  describe("(c) With real distPath, /api/* returns 404 (NOT served by static)", () => {
    let app: express.Express;
    let server: http.Server;

    beforeEach(() => {
      // Create sample index.html
      fs.writeFileSync(path.join(tempDir, "index.html"), "<html><body>SPA</body></html>");

      app = express();
      mountStatic(app, tempDir);
      server = app.listen(TEST_PORT + 2);
    });

    afterEach(() => {
      server.close();
    });

    it("GET /api/anything returns 404 (not handled by static)", async () => {
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 2) + "/api/anything");
      expect(response.status).toBe(404);
    });

    it("GET /api/health returns 404 (not handled by static)", async () => {
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 2) + "/api/health");
      expect(response.status).toBe(404);
    });
  });
});
