import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "node:http";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

const TEST_PORT = 18761;

describe("Settings Routes", () => {
  let mountSettingsRoutes: (app: express.Express, deps?: { homeDir?: string }) => void;
  let tempDir: string;

  beforeEach(async () => {
    const module = await import("../routes/settings");
    mountSettingsRoutes = module.mountSettingsRoutes;

    // Create a temporary directory to serve as homeDir
    tempDir = await mkdtemp(join(tmpdir(), "pi-settings-test-"));
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  function createTestApp(homeDir: string): express.Express {
    const app = express();
    app.use(express.json());
    mountSettingsRoutes(app, { homeDir });
    return app;
  }

  describe("GET /api/settings", () => {
    it("returns empty object when settings file does not exist", async () => {
      const app = createTestApp(tempDir);
      const server = app.listen(TEST_PORT);

      const response = await fetch("http://127.0.0.1:" + TEST_PORT + "/api/settings");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({});

      server.close();
    });

    it("returns settings object when file exists with valid JSON", async () => {
      // Create the .pi/agent directory structure
      const agentDir = join(tempDir, ".pi", "agent");
      await mkdir(agentDir, { recursive: true });
      const settingsPath = join(agentDir, "settings.json");

      const existingSettings = { theme: "dark", timeout: 30 };
      await writeFile(settingsPath, JSON.stringify(existingSettings), "utf-8");

      const app = createTestApp(tempDir);
      const server = app.listen(TEST_PORT + 1);

      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 1) + "/api/settings");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(existingSettings);

      server.close();
    });

    it("returns empty object when file contains corrupted JSON", async () => {
      const agentDir = join(tempDir, ".pi", "agent");
      await mkdir(agentDir, { recursive: true });
      const settingsPath = join(agentDir, "settings.json");

      // Write corrupted JSON
      await writeFile(settingsPath, "{ invalid json }", "utf-8");

      const app = createTestApp(tempDir);
      const server = app.listen(TEST_PORT + 2);

      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 2) + "/api/settings");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({});

      server.close();
    });

    it("returns empty object when file is empty", async () => {
      const agentDir = join(tempDir, ".pi", "agent");
      await mkdir(agentDir, { recursive: true });
      const settingsPath = join(agentDir, "settings.json");

      // Write empty file
      await writeFile(settingsPath, "", "utf-8");

      const app = createTestApp(tempDir);
      const server = app.listen(TEST_PORT + 3);

      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 3) + "/api/settings");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({});

      server.close();
    });
  });

  describe("PATCH /api/settings", () => {
    it("creates settings file with partial object when none exists", async () => {
      const app = createTestApp(tempDir);
      const server = app.listen(TEST_PORT + 10);

      const partialSettings = { theme: "light" };
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 10) + "/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(partialSettings),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(partialSettings);

      // Verify file was created
      const settingsPath = join(tempDir, ".pi", "agent", "settings.json");
      const fs = await import("node:fs/promises");
      const content = await fs.readFile(settingsPath, "utf-8");
      expect(JSON.parse(content)).toEqual(partialSettings);

      server.close();
    });

    it("deep-merges partial object into existing settings", async () => {
      // Create existing settings
      const agentDir = join(tempDir, ".pi", "agent");
      await mkdir(agentDir, { recursive: true });
      const settingsPath = join(agentDir, "settings.json");
      const existingSettings = { theme: "dark", timeout: 30, nested: { a: 1, b: 2 } };
      await writeFile(settingsPath, JSON.stringify(existingSettings), "utf-8");

      const app = createTestApp(tempDir);
      const server = app.listen(TEST_PORT + 11);

      const patch = { timeout: 60, nested: { b: 3, c: 4 } };
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 11) + "/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      // Expected: theme from existing, timeout and nested merged
      expect(body).toEqual({
        theme: "dark",
        timeout: 60,
        nested: { a: 1, b: 3, c: 4 },
      });

      server.close();
    });

    it("replaces arrays instead of merging them", async () => {
      const agentDir = join(tempDir, ".pi", "agent");
      await mkdir(agentDir, { recursive: true });
      const settingsPath = join(agentDir, "settings.json");
      const existingSettings = { items: [1, 2, 3] };
      await writeFile(settingsPath, JSON.stringify(existingSettings), "utf-8");

      const app = createTestApp(tempDir);
      const server = app.listen(TEST_PORT + 12);

      const patch = { items: [4, 5] };
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 12) + "/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items).toEqual([4, 5]);

      server.close();
    });

    it("returns the complete merged settings object", async () => {
      const agentDir = join(tempDir, ".pi", "agent");
      await mkdir(agentDir, { recursive: true });
      const settingsPath = join(agentDir, "settings.json");
      const existingSettings = { a: 1, b: 2 };
      await writeFile(settingsPath, JSON.stringify(existingSettings), "utf-8");

      const app = createTestApp(tempDir);
      const server = app.listen(TEST_PORT + 13);

      const patch = { b: 3, c: 4 };
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 13) + "/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ a: 1, b: 3, c: 4 });

      server.close();
    });

    it("handles patch with nested objects multiple levels deep", async () => {
      const agentDir = join(tempDir, ".pi", "agent");
      await mkdir(agentDir, { recursive: true });
      const settingsPath = join(agentDir, "settings.json");
      const existingSettings = { level1: { level2: { level3: { value: "original" } } } };
      await writeFile(settingsPath, JSON.stringify(existingSettings), "utf-8");

      const app = createTestApp(tempDir);
      const server = app.listen(TEST_PORT + 14);

      const patch = { level1: { level2: { level3: { other: "new" } } } };
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 14) + "/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        level1: { level2: { level3: { value: "original", other: "new" } } },
      });

      server.close();
    });
  });

  describe("edge cases", () => {
    it("GET returns empty object when parent directories do not exist", async () => {
      // tempDir has no .pi/agent subdirectory - should return {}
      const app = createTestApp(tempDir);
      const server = app.listen(TEST_PORT + 20);

      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 20) + "/api/settings");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({});

      server.close();
    });

    it("PATCH creates intermediate directories if needed", async () => {
      // tempDir has no .pi/agent subdirectory - should still work
      const app = createTestApp(tempDir);
      const server = app.listen(TEST_PORT + 21);

      const patch = { newSetting: true };
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 21) + "/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(patch);

      // Verify directories were created
      const settingsPath = join(tempDir, ".pi", "agent", "settings.json");
      const fs = await import("node:fs/promises");
      const content = await fs.readFile(settingsPath, "utf-8");
      expect(JSON.parse(content)).toEqual(patch);

      server.close();
    });
  });
});
