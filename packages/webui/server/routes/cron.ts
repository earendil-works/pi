import express from "express";
import type { CronStore as CronStoreType, CronJob, Schedule } from "../cron-store";

function isValidScheduleKind(kind: unknown): kind is Schedule["kind"] {
  return kind === "at" || kind === "every" || kind === "cron";
}

function validateSchedule(schedule: unknown): schedule is Schedule {
  if (!schedule || typeof schedule !== "object") {
    return false;
  }
  const s = schedule as Record<string, unknown>;
  if (!isValidScheduleKind(s.kind)) {
    return false;
  }
  if (s.kind === "at" && typeof s.time !== "string") {
    return false;
  }
  if (s.kind === "every" && typeof s.interval !== "number") {
    return false;
  }
  if (s.kind === "cron" && typeof s.expr !== "string") {
    return false;
  }
  return true;
}

export function mountCronRoutes(app: express.Express, cronStore: CronStoreType): void {
  // GET /api/cron/jobs - list all jobs
  app.get("/api/cron/jobs", async (_req, res) => {
    try {
      const jobs = await cronStore.list();
      res.json(jobs);
    } catch (err) {
      console.error("Error listing cron jobs:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/cron/jobs - add new job
  app.post("/api/cron/jobs", async (req, res) => {
    try {
      const { name, schedule, prompt, enabled } = req.body;

      // Validate required fields
      if (!name || typeof name !== "string") {
        res.status(400).json({ error: "name is required and must be a string" });
        return;
      }
      if (!schedule || !validateSchedule(schedule)) {
        res.status(400).json({ error: "schedule is required and schedule.kind must be 'at' | 'every' | 'cron'" });
        return;
      }
      if (!prompt || typeof prompt !== "string") {
        res.status(400).json({ error: "prompt is required and must be a string" });
        return;
      }

      const newJob = await cronStore.add({
        name,
        schedule,
        prompt,
        enabled: enabled ?? true,
      });

      res.json(newJob);
    } catch (err) {
      console.error("Error creating cron job:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PUT /api/cron/jobs/:id - update job
  app.put("/api/cron/jobs/:id", async (req, res) => {
    try {
      const { id } = req.params;

      // Check if job exists
      const existing = await cronStore.get(id);
      if (!existing) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      // Validate schedule if provided
      const { schedule } = req.body;
      if (schedule !== undefined && !validateSchedule(schedule)) {
        res.status(400).json({ error: "schedule.kind must be 'at' | 'every' | 'cron'" });
        return;
      }

      const updated = await cronStore.update(id, req.body);
      res.json(updated);
    } catch (err) {
      console.error("Error updating cron job:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/cron/jobs/:id - remove job
  app.delete("/api/cron/jobs/:id", async (req, res) => {
    try {
      const { id } = req.params;

      const removed = await cronStore.remove(id);
      if (!removed) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      res.json({ ok: true });
    } catch (err) {
      console.error("Error deleting cron job:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/cron/jobs/:id/trigger - trigger job now
  app.post("/api/cron/jobs/:id/trigger", async (req, res) => {
    try {
      const { id } = req.params;

      // Check if job exists
      const existing = await cronStore.get(id);
      if (!existing) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      const triggered = await cronStore.triggerNow(id);
      res.json(triggered);
    } catch (err) {
      console.error("Error triggering cron job:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });
}
