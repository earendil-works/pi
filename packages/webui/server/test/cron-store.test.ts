import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

interface CronJob {
  id: string;
  name: string;
  schedule: { kind: "at"; time: string } | { kind: "every"; interval: number } | { kind: "cron"; expr: string; tz?: string };
  prompt: string;
  enabled: boolean;
  last_run: string | null;
  last_run_status?: "ok" | "error" | null;
  created_at: string;
}

describe("CronStore", () => {
  let CronStore: typeof import("../cron-store").CronStore;
  let dataDir: string;
  let dataPath: string;

  beforeEach(async () => {
    // Dynamic import to load CronStore
    const module = await import("../cron-store");
    CronStore = module.CronStore;

    // Use a unique temp dir for each test
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-store-test-"));
    dataPath = path.join(dataDir, "cron.json");
  });

  afterEach(async () => {
    // Clean up temp files
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  describe("(a) add → list returns 1", () => {
    it("adding a job makes list return that job", async () => {
      const store = new CronStore({ dataPath });

      await store.add({
        name: "Test Job",
        schedule: { kind: "at", time: "09:00" },
        prompt: "Say hello",
        enabled: true,
      });

      const jobs = await store.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe("Test Job");
      expect(jobs[0].schedule).toEqual({ kind: "at", time: "09:00" });
      expect(jobs[0].prompt).toBe("Say hello");
      expect(jobs[0].enabled).toBe(true);
      expect(jobs[0].id).toBeDefined();
      expect(jobs[0].created_at).toBeDefined();
      expect(jobs[0].last_run).toBeNull();
    });
  });

  describe("(b) update with partial fields", () => {
    it("can update a subset of fields without affecting others", async () => {
      const store = new CronStore({ dataPath });

      const added = await store.add({
        name: "Original Name",
        schedule: { kind: "every", interval: 60 },
        prompt: "Original prompt",
        enabled: true,
      });

      const updated = await store.update(added.id, {
        name: "Updated Name",
        enabled: false,
      });

      expect(updated.name).toBe("Updated Name");
      expect(updated.prompt).toBe("Original prompt");
      expect(updated.schedule).toEqual({ kind: "every", interval: 60 });
      expect(updated.enabled).toBe(false);
      expect(updated.id).toBe(added.id);
      expect(updated.created_at).toBe(added.created_at);
    });
  });

  describe("(c) remove filters out", () => {
    it("removed job no longer appears in list", async () => {
      const store = new CronStore({ dataPath });

      const added = await store.add({
        name: "Job to Remove",
        schedule: { kind: "at", time: "12:00" },
        prompt: "Remove me",
        enabled: true,
      });

      expect(await store.list()).toHaveLength(1);

      const removed = await store.remove(added.id);
      expect(removed).toBe(true);
      expect(await store.list()).toHaveLength(0);
    });

    it("remove returns false for non-existent id", async () => {
      const store = new CronStore({ dataPath });
      const removed = await store.remove("non-existent-id");
      expect(removed).toBe(false);
    });
  });

  describe("(d) triggerNow sets last_run to null", () => {
    it("triggerNow sets last_run to null", async () => {
      const store = new CronStore({ dataPath });

      const added = await store.add({
        name: "Trigger Test",
        schedule: { kind: "cron", expr: "0 9 * * 1-5" },
        prompt: "Trigger me",
        enabled: true,
      });

      // Simulate that it has run
      await store.update(added.id, { last_run: new Date().toISOString() });

      const triggered = await store.triggerNow(added.id);
      expect(triggered.last_run).toBeNull();
    });
  });

  describe("(e) concurrent add via Promise.all doesn't corrupt file", () => {
    it("concurrent adds are serialized and all jobs are persisted", async () => {
      const store = new CronStore({ dataPath });

      const addJobs = Array.from({ length: 10 }, (_, i) =>
        store.add({
          name: `Concurrent Job ${i}`,
          schedule: { kind: "every", interval: 100 + i },
          prompt: `Prompt ${i}`,
          enabled: true,
        })
      );

      const results = await Promise.all(addJobs);
      expect(results).toHaveLength(10);

      const jobs = await store.list();
      expect(jobs).toHaveLength(10);

      // Verify all jobs have unique IDs
      const ids = jobs.map((j) => j.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(10);
    });
  });

  describe("get()", () => {
    it("returns a specific job by id", async () => {
      const store = new CronStore({ dataPath });

      const added = await store.add({
        name: "Get Test",
        schedule: { kind: "at", time: "10:00" },
        prompt: "Get me",
        enabled: true,
      });

      const job = await store.get(added.id);
      expect(job).toBeDefined();
      expect(job!.name).toBe("Get Test");
    });

    it("returns undefined for non-existent id", async () => {
      const store = new CronStore({ dataPath });
      const job = await store.get("non-existent");
      expect(job).toBeUndefined();
    });
  });

  describe("file initialization", () => {
    it("list returns empty array when file doesn't exist", async () => {
      const store = new CronStore({ dataPath });
      const jobs = await store.list();
      expect(jobs).toEqual([]);
    });

    it("creates file on first add", async () => {
      const store = new CronStore({ dataPath });
      await store.add({
        name: "First Job",
        schedule: { kind: "at", time: "08:00" },
        prompt: "First",
        enabled: true,
      });

      const fileExists = await fs.access(dataPath).then(() => true).catch(() => false);
      expect(fileExists).toBe(true);
    });
  });
});
