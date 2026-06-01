import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "node:http";
import { AddressInfo } from "node:net";

const TEST_PORT = 18751;

describe("Health Check Endpoint", () => {
  let mountHealth: (app: express.Express, deps?: {
    getSessionCount?: () => number;
    startedAt?: number;
  }) => void;
  let packageVersion: string;

  beforeEach(async () => {
    // Dynamic import to load mountHealth
    const module = await import("../routes/health");
    mountHealth = module.mountHealth;

    // Get package version for assertions
    const pkg = await import("../../package.json", { with: { type: "json" } });
    packageVersion = pkg.default.version;
  });

  describe("(a) GET /api/health returns 200 with body containing ok:true", () => {
    let app: express.Express;
    let server: http.Server;

    beforeEach(() => {
      app = express();
      mountHealth(app);
      server = app.listen(TEST_PORT);
    });

    afterEach(() => {
      server.close();
    });

    it("returns 200 status", async () => {
      const response = await fetch("http://127.0.0.1:" + TEST_PORT + "/api/health");
      expect(response.status).toBe(200);
    });

    it("returns body containing ok:true", async () => {
      const response = await fetch("http://127.0.0.1:" + TEST_PORT + "/api/health");
      const body = await response.json();
      expect(body.ok).toBe(true);
    });
  });

  describe("(b) Response body has keys: ok, version, uptime, sessions", () => {
    let app: express.Express;
    let server: http.Server;

    beforeEach(() => {
      app = express();
      mountHealth(app);
      server = app.listen(TEST_PORT + 1);
    });

    afterEach(() => {
      server.close();
    });

    it("has ok key", async () => {
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 1) + "/api/health");
      const body = await response.json();
      expect(body).toHaveProperty("ok");
    });

    it("has version key", async () => {
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 1) + "/api/health");
      const body = await response.json();
      expect(body).toHaveProperty("version");
    });

    it("has uptime key", async () => {
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 1) + "/api/health");
      const body = await response.json();
      expect(body).toHaveProperty("uptime");
    });

    it("has sessions key", async () => {
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 1) + "/api/health");
      const body = await response.json();
      expect(body).toHaveProperty("sessions");
    });
  });

  describe("(c) version is the package.json version", () => {
    let app: express.Express;
    let server: http.Server;

    beforeEach(() => {
      app = express();
      mountHealth(app);
      server = app.listen(TEST_PORT + 2);
    });

    afterEach(() => {
      server.close();
    });

    it("version matches package.json version", async () => {
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 2) + "/api/health");
      const body = await response.json();
      expect(body.version).toBe(packageVersion);
    });
  });

  describe("(d) uptime is a positive number (seconds)", () => {
    let app: express.Express;
    let server: http.Server;

    beforeEach(() => {
      app = express();
      mountHealth(app);
      server = app.listen(TEST_PORT + 3);
    });

    afterEach(() => {
      server.close();
    });

    it("uptime is a number", async () => {
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 3) + "/api/health");
      const body = await response.json();
      expect(typeof body.uptime).toBe("number");
    });

    it("uptime is non-negative", async () => {
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 3) + "/api/health");
      const body = await response.json();
      expect(body.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe("(e) sessions defaults to 0 (no session pool wired yet)", () => {
    let app: express.Express;
    let server: http.Server;

    beforeEach(() => {
      app = express();
      mountHealth(app);
      server = app.listen(TEST_PORT + 4);
    });

    afterEach(() => {
      server.close();
    });

    it("sessions is 0 when no getSessionCount provided", async () => {
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 4) + "/api/health");
      const body = await response.json();
      expect(body.sessions).toBe(0);
    });
  });

  describe("(f) When getSessionCount dep is provided, it uses that value", () => {
    let app: express.Express;
    let server: http.Server;

    beforeEach(() => {
      app = express();
      mountHealth(app, {
        getSessionCount: () => 42,
      });
      server = app.listen(TEST_PORT + 5);
    });

    afterEach(() => {
      server.close();
    });

    it("sessions uses getSessionCount value", async () => {
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 5) + "/api/health");
      const body = await response.json();
      expect(body.sessions).toBe(42);
    });
  });

  describe("(g) When startedAt dep is provided, uptime is calculated correctly", () => {
    let app: express.Express;
    let server: http.Server;

    beforeEach(() => {
      app = express();
      // Simulate startedAt 5 seconds ago
      const startedAt = Date.now() - 5000;
      mountHealth(app, { startedAt });
      server = app.listen(TEST_PORT + 6);
    });

    afterEach(() => {
      server.close();
    });

    it("uptime is approximately 5 seconds", async () => {
      const response = await fetch("http://127.0.0.1:" + (TEST_PORT + 6) + "/api/health");
      const body = await response.json();
      // Allow some tolerance for test execution time
      expect(body.uptime).toBeGreaterThanOrEqual(4);
      expect(body.uptime).toBeLessThanOrEqual(7);
    });
  });
});
