/**
 * CronStore - Atomic read/write access to cron.json with in-process mutex
 */

import { homedir } from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";

// ============================================================================
// Types
// ============================================================================

export type Schedule =
  | { kind: "at"; time: string }
  | { kind: "every"; interval: number }
  | { kind: "cron"; expr: string; tz?: string };

export interface CronJob {
  id: string;
  name: string;
  schedule: Schedule;
  prompt: string;
  enabled: boolean;
  last_run: string | null;
  last_run_status?: "ok" | "error" | null;
  created_at: string;
}

// ============================================================================
// Constants
// ============================================================================

export const CRON_DATA_PATH = path.join(homedir(), ".pi", "agent", "data", "cron.json");

// ============================================================================
// Mutex (inline implementation since async-mutex not installed)
// ============================================================================

type MutexValue = {
  locked: boolean;
  queue: Array<() => void>;
};

function createMutex(): {
  acquire: () => Promise<() => void>;
} {
  const value: MutexValue = { locked: false, queue: [] };

  return {
    acquire(): Promise<() => void> {
      return new Promise((resolve) => {
        const release = () => {
          const next = value.queue.shift();
          if (next) {
            next();
          } else {
            value.locked = false;
          }
        };

        if (!value.locked) {
          value.locked = true;
          resolve(release);
        } else {
          value.queue.push(() => {
            resolve(release);
          });
        }
      });
    },
  };
}

// ============================================================================
// CronStore
// ============================================================================

export class CronStore {
  private readonly dataPath: string;
  private readonly mutex = createMutex();
  private readonly encoder = new TextEncoder();

  constructor(opts?: { dataPath?: string }) {
    this.dataPath = opts?.dataPath ?? CRON_DATA_PATH;
  }

  /**
   * Atomically read all jobs from cron.json
   */
  private async readJobs(): Promise<CronJob[]> {
    try {
      const data = await fs.readFile(this.dataPath, "utf-8");
      return JSON.parse(data) as CronJob[];
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  /**
   * Atomically write jobs to cron.json using tmp + rename
   */
  private async writeJobs(jobs: CronJob[]): Promise<void> {
    const dir = path.dirname(this.dataPath);
    await fs.mkdir(dir, { recursive: true });

    const tmpPath = `${this.dataPath}.tmp.${crypto.randomUUID()}`;
    const json = JSON.stringify(jobs, null, 2);
    await fs.writeFile(tmpPath, json, "utf-8");
    await fs.rename(tmpPath, this.dataPath);
  }

  /**
   * List all cron jobs
   */
  async list(): Promise<CronJob[]> {
    const release = await this.mutex.acquire();
    try {
      return await this.readJobs();
    } finally {
      release();
    }
  }

  /**
   * Get a specific job by id
   */
  async get(id: string): Promise<CronJob | undefined> {
    const release = await this.mutex.acquire();
    try {
      const jobs = await this.readJobs();
      return jobs.find((j) => j.id === id);
    } finally {
      release();
    }
  }

  /**
   * Add a new cron job
   */
  async add(input: Omit<CronJob, "id" | "created_at" | "last_run">): Promise<CronJob> {
    const release = await this.mutex.acquire();
    try {
      const jobs = await this.readJobs();

      const newJob: CronJob = {
        ...input,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        last_run: null,
      };

      jobs.push(newJob);
      await this.writeJobs(jobs);

      return newJob;
    } finally {
      release();
    }
  }

  /**
   * Update an existing cron job
   */
  async update(
    id: string,
    partial: Partial<Omit<CronJob, "id" | "created_at">>
  ): Promise<CronJob> {
    const release = await this.mutex.acquire();
    try {
      const jobs = await this.readJobs();
      const index = jobs.findIndex((j) => j.id === id);

      if (index === -1) {
        throw new Error(`Job not found: ${id}`);
      }

      const updated: CronJob = {
        ...jobs[index],
        ...partial,
        id: jobs[index].id,
        created_at: jobs[index].created_at,
      };

      jobs[index] = updated;
      await this.writeJobs(jobs);

      return updated;
    } finally {
      release();
    }
  }

  /**
   * Remove a cron job by id
   * @returns true if the job was removed, false if not found
   */
  async remove(id: string): Promise<boolean> {
    const release = await this.mutex.acquire();
    try {
      const jobs = await this.readJobs();
      const initialLength = jobs.length;
      const filtered = jobs.filter((j) => j.id !== id);

      if (filtered.length === initialLength) {
        return false;
      }

      await this.writeJobs(filtered);
      return true;
    } finally {
      release();
    }
  }

  /**
   * Trigger a job to run now by setting last_run to null
   */
  async triggerNow(id: string): Promise<CronJob> {
    return this.update(id, { last_run: null });
  }
}
