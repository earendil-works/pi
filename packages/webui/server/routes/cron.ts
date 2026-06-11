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
  switch (s.kind) {
    case "at":
      return typeof s.time === "string";
    case "every":
      return typeof s.interval === "number";
    case "cron":
      return typeof s.expr === "string";
  }
}

interface ValidCronJobInput {
  name: string;
  prompt: string;
  schedule: Schedule;
  enabled?: boolean;
}

function validateCronJobInput(body: unknown): ValidCronJobInput | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "body must be object" };
  }
  const b = body as Record<string, unknown>;

  // name: string, length 1-200
  if (typeof b.name !== "string" || b.name.length === 0 || b.name.length > 200) {
    return { error: "name must be string 1-200 chars" };
  }

  // prompt: string, length 1-32000
  if (typeof b.prompt !== "string" || b.prompt.length === 0 || b.prompt.length > 32000) {
    return { error: "prompt must be string 1-32k chars" };
  }

  // enabled: boolean (optional, defaults to true)
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") {
    return { error: "enabled must be boolean" };
  }

  // schedule: object with kind
  if (typeof b.schedule !== "object" || b.schedule === null) {
    return { error: "schedule required" };
  }
  const s = b.schedule as Record<string, unknown>;

  if (s.kind !== "at" && s.kind !== "every" && s.kind !== "cron") {
    return { error: "schedule.kind must be at|every|cron" };
  }

  if (s.kind === "at") {
    if (typeof s.time !== "string" || !/^\d{2}:\d{2}$/.test(s.time)) {
      return { error: "at requires time HH:MM" };
    }
  } else if (s.kind === "every") {
    if (
      typeof s.interval !== "number" ||
      s.interval <= 0 ||
      s.interval > 31536000 ||
      !Number.isInteger(s.interval)
    ) {
      return { error: "every requires positive integer interval <= 31536000" };
    }
  } else if (s.kind === "cron") {
    if (typeof s.expr !== "string" || s.expr.length === 0 || s.expr.length > 100) {
      return { error: "cron requires expr string <= 100 chars" };
    }
  }

  // Build allowed schedule fields only
  const scheduleOut: Record<string, unknown> = { kind: s.kind };
  if (s.time !== undefined) scheduleOut.time = s.time;
  if (s.interval !== undefined) scheduleOut.interval = s.interval;
  if (s.expr !== undefined) scheduleOut.expr = s.expr;
  if (s.tz !== undefined) scheduleOut.tz = s.tz;

  return {
    name: b.name,
    prompt: b.prompt,
    enabled: b.enabled ?? true,
    schedule: scheduleOut as Schedule,
  };
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
      const validated = validateCronJobInput(req.body);
      if ("error" in validated) {
        res.status(400).json({ error: validated.error });
        return;
      }

      const newJob = await cronStore.add({
        name: validated.name,
        schedule: validated.schedule,
        prompt: validated.prompt,
        enabled: validated.enabled,
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

      // Strip last_run and last_run_status to prevent client spoofing
      const { last_run: _lr, last_run_status: _lrs, ...allowed } = req.body;

      // Validate schedule if provided
      const { schedule } = allowed;
      if (schedule !== undefined && !validateSchedule(schedule)) {
        res.status(400).json({ error: "schedule.kind must be 'at' | 'every' | 'cron'" });
        return;
      }

      const updated = await cronStore.update(id, allowed);
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
