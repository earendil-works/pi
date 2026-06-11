import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

const TEST_PORT = 18761;

describe("Cron REST API Endpoints", () => {
  let mountCronRoutes: (app: express.Express, cronStore: any) => void;
  let CronStore: any;
  let tempFilePath: string;

  beforeEach(async () => {
    // Dynamic imports
    const cronModule = await import("../routes/cron");
    mountCronRoutes = cronModule.mountCronRoutes;

    const storeModule = await import("../cron-store");
    CronStore = storeModule.CronStore;

    // Create unique temp file for each test
    tempFilePath = path.join(
      "/tmp",
      `cron-test-${crypto.randomUUID()}.json`
    );
  });

  afterEach(async () => {
    // Cleanup temp file
    try {
      await fs.unlink(tempFilePath);
    } catch {
      // ignore
    }
  });

  // (a) GET /api/cron/jobs returns []
  describe("(a) GET /api/cron/jobs returns []", () => {
    let app: express.Express;
    let server: ReturnType<typeof createServer>;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      const store = new CronStore({ dataPath: tempFilePath });
      mountCronRoutes(app, store);
      server = createServer(app);
    });

    afterEach(() => {
      server.close();
    });

    it("returns empty array when no jobs exist", async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;

      const res = await fetch(`http://127.0.0.1:${port}/api/cron/jobs`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual([]);
    });
  });

  // (b) POST /api/cron/jobs with valid body returns 200 + new job with id+created_at
  describe("(b) POST /api/cron/jobs with valid body returns 200 + new job with id+created_at", () => {
    let app: express.Express;
    let server: ReturnType<typeof createServer>;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      const store = new CronStore({ dataPath: tempFilePath });
      mountCronRoutes(app, store);
      server = createServer(app);
    });

    afterEach(() => {
      server.close();
    });

    it("creates a new job with server-generated id and created_at", async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;

      const res = await fetch(`http://127.0.0.1:${port}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Job",
          schedule: { kind: "every", interval: 3600 },
          prompt: "Say hello",
          enabled: true,
        }),
      });

      expect(res.status).toBe(200);

      const job = await res.json();
      expect(job).toHaveProperty("id");
      expect(job).toHaveProperty("created_at");
      expect(job.id).toBeTruthy();
      expect(job.created_at).toBeTruthy();
      expect(job.name).toBe("Test Job");
      expect(job.schedule).toEqual({ kind: "every", interval: 3600 });
      expect(job.prompt).toBe("Say hello");
      expect(job.enabled).toBe(true);
      expect(job.last_run).toBe(null);
    });
  });

  // (c) POST /api/cron/jobs with missing name returns 400
  describe("(c) POST /api/cron/jobs with missing name returns 400", () => {
    let app: express.Express;
    let server: ReturnType<typeof createServer>;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      const store = new CronStore({ dataPath: tempFilePath });
      mountCronRoutes(app, store);
      server = createServer(app);
    });

    afterEach(() => {
      server.close();
    });

    it("returns 400 when name is missing", async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;

      const res = await fetch(`http://127.0.0.1:${port}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schedule: { kind: "every", interval: 3600 },
          prompt: "Say hello",
          enabled: true,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toHaveProperty("error");
    });
  });

  // (d) POST /api/cron/jobs with invalid schedule.kind returns 400
  describe("(d) POST /api/cron/jobs with invalid schedule.kind returns 400", () => {
    let app: express.Express;
    let server: ReturnType<typeof createServer>;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      const store = new CronStore({ dataPath: tempFilePath });
      mountCronRoutes(app, store);
      server = createServer(app);
    });

    afterEach(() => {
      server.close();
    });

    it("returns 400 when schedule.kind is invalid", async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;

      const res = await fetch(`http://127.0.0.1:${port}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Job",
          schedule: { kind: "invalid" as any, time: "10:00" },
          prompt: "Say hello",
          enabled: true,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toHaveProperty("error");
      expect(body.error).toContain("schedule.kind");
    });
  });

  // (e) GET /api/cron/jobs after add returns 1
  describe("(e) GET /api/cron/jobs after add returns 1", () => {
    let app: express.Express;
    let server: ReturnType<typeof createServer>;
    let createdJobId: string;

    beforeEach(async () => {
      app = express();
      app.use(express.json());
      const store = new CronStore({ dataPath: tempFilePath });
      mountCronRoutes(app, store);
      server = createServer(app);

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;

      // Create a job first
      const res = await fetch(`http://127.0.0.1:${port}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Job",
          schedule: { kind: "at", time: "10:00" },
          prompt: "Say hello",
          enabled: true,
        }),
      });

      const job = await res.json();
      createdJobId = job.id;
    });

    afterEach(() => {
      server.close();
    });

    it("returns 1 job after adding one", async () => {
      const port = (server.address() as any).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/cron/jobs`);

      const jobs = await res.json();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(createdJobId);
    });
  });

  // (f) PUT /api/cron/jobs/:id updates fields
  describe("(f) PUT /api/cron/jobs/:id updates fields", () => {
    let app: express.Express;
    let server: ReturnType<typeof createServer>;
    let createdJobId: string;

    beforeEach(async () => {
      app = express();
      app.use(express.json());
      const store = new CronStore({ dataPath: tempFilePath });
      mountCronRoutes(app, store);
      server = createServer(app);

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;

      // Create a job first
      const res = await fetch(`http://127.0.0.1:${port}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Original Name",
          schedule: { kind: "at", time: "10:00" },
          prompt: "Original prompt",
          enabled: true,
        }),
      });

      const job = await res.json();
      createdJobId = job.id;
    });

    afterEach(() => {
      server.close();
    });

    it("updates the job with new values", async () => {
      const port = (server.address() as any).port;

      const res = await fetch(`http://127.0.0.1:${port}/api/cron/jobs/${createdJobId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Updated Name",
          enabled: false,
        }),
      });

      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.name).toBe("Updated Name");
      expect(updated.enabled).toBe(false);
      expect(updated.schedule).toEqual({ kind: "at", time: "10:00" }); // unchanged
      expect(updated.prompt).toBe("Original prompt"); // unchanged
    });
  });

  // (g) DELETE /api/cron/jobs/:id removes and returns 200; subsequent GET returns []
  describe("(g) DELETE /api/cron/jobs/:id removes and returns 200", () => {
    let app: express.Express;
    let server: ReturnType<typeof createServer>;
    let createdJobId: string;

    beforeEach(async () => {
      app = express();
      app.use(express.json());
      const store = new CronStore({ dataPath: tempFilePath });
      mountCronRoutes(app, store);
      server = createServer(app);

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;

      // Create a job first
      const res = await fetch(`http://127.0.0.1:${port}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "To Be Deleted",
          schedule: { kind: "every", interval: 60 },
          prompt: "Goodbye",
          enabled: true,
        }),
      });

      const job = await res.json();
      createdJobId = job.id;
    });

    afterEach(() => {
      server.close();
    });

    it("deletes the job and subsequent GET returns []", async () => {
      const port = (server.address() as any).port;

      // Delete
      const delRes = await fetch(`http://127.0.0.1:${port}/api/cron/jobs/${createdJobId}`, {
        method: "DELETE",
      });

      expect(delRes.status).toBe(200);
      const delBody = await delRes.json();
      expect(delBody).toEqual({ ok: true });

      // Verify deleted
      const getRes = await fetch(`http://127.0.0.1:${port}/api/cron/jobs`);
      const jobs = await getRes.json();
      expect(jobs).toEqual([]);
    });

    it("returns 404 when deleting non-existent job", async () => {
      const port = (server.address() as any).port;

      const res = await fetch(`http://127.0.0.1:${port}/api/cron/jobs/non-existent-id`, {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
    });
  });

  // (h) POST /api/cron/jobs/:id/trigger sets last_run: null
  describe("(h) POST /api/cron/jobs/:id/trigger sets last_run: null", () => {
    let app: express.Express;
    let server: ReturnType<typeof createServer>;
    let createdJobId: string;

    beforeEach(async () => {
      app = express();
      app.use(express.json());
      const store = new CronStore({ dataPath: tempFilePath });
      mountCronRoutes(app, store);
      server = createServer(app);

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;

      // Create a job first
      const res = await fetch(`http://127.0.0.1:${port}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Trigger Test",
          schedule: { kind: "cron", expr: "0 * * * *" },
          prompt: "Run me",
          enabled: true,
        }),
      });

      const job = await res.json();
      createdJobId = job.id;
    });

    afterEach(() => {
      server.close();
    });

    it("sets last_run to null when triggered", async () => {
      const port = (server.address() as any).port;

      const res = await fetch(`http://127.0.0.1:${port}/api/cron/jobs/${createdJobId}/trigger`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const triggered = await res.json();
      expect(triggered.last_run).toBe(null);
    });
  });
});
