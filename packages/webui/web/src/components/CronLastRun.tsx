import { CheckCircle, XCircle, Minus, Clock } from "lucide-react";
import type { CronJob } from "../lib/api";

interface CronLastRunProps {
  job: CronJob;
}

/** Parse "at HH:MM" or "at H:MM" syntax */
function parseAtSchedule(schedule: string): { hour: number; minute: number } | null {
  const match = schedule.match(/^at\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return { hour: parseInt(match[1], 10), minute: parseInt(match[2], 10) };
}

/** Parse "every N seconds/minutes/hours" syntax */
function parseEverySchedule(
  schedule: string
): { value: number; unit: "seconds" | "minutes" | "hours" } | null {
  const match = schedule.match(/^every\s+(\d+)\s+(second|minute|hour|seconds|minutes|hours)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].replace(/s$/, "") as "second" | "minute" | "hour";
  return { value, unit };
}

/** Compute next scheduled fire time from a base date */
function computeNextFire(baseMs: number, schedule: string): Date | null {
  // "at" syntax: at HH:MM
  const atMatch = parseAtSchedule(schedule);
  if (atMatch) {
    const now = new Date(baseMs);
    const today = new Date(baseMs);
    today.setHours(atMatch.hour, atMatch.minute, 0, 0);
    // If today's slot has passed, use tomorrow
    if (today.getTime() <= now.getTime()) {
      today.setDate(today.getDate() + 1);
    }
    return today;
  }

  // "every" syntax: every N seconds|minutes|hours
  const everyMatch = parseEverySchedule(schedule);
  if (everyMatch) {
    const multiplier =
      everyMatch.unit === "seconds"
        ? 1000
        : everyMatch.unit === "minutes"
          ? 60 * 1000
          : 60 * 60 * 1000;
    return new Date(baseMs + everyMatch.value * multiplier);
  }

  // Cron expression (5 fields): minute hour day month weekday
  // Lightweight parser for common patterns
  const parts = schedule.trim().split(/\s+/);
  if (parts.length === 5) {
    const [minute, hour, day, month, weekday] = parts;
    const now = new Date(baseMs);
    const currentYear = now.getFullYear();

    // Simple helper: get next occurrence of a field value (or *)
    const nextOf =
      (field: string, current: number, max: number, wrap: boolean): number => {
        if (field === "*") return current;
        const vals = field.split(",").flatMap((r) => {
          const range = r.match(/^(\d+)(?:-(\d+))?$/);
          if (!range) return parseInt(r, 10);
          const start = parseInt(range[1], 10);
          const end = range[2] ? parseInt(range[2], 10) : start;
          const result: number[] = [];
          for (let i = start; i <= end; i++) result.push(i);
          return result;
        });
        for (const v of vals.sort((a, b) => a - b)) {
          if (v > current) return v;
        }
        return wrap ? vals[0] ?? current : current;
      };

    // Try up to 2 years worth of iterations to avoid infinite loop
    for (let yearOffset = 0; yearOffset <= 1; yearOffset++) {
      const year = currentYear + yearOffset;
      const candidateHour = nextOf(hour, 0, 23, false);
      const candidateMinute = nextOf(minute, 0, 59, false);

      // Build candidate date
      const cand = new Date(year, 0, 1, candidateHour, candidateMinute, 0, 0);

      // Check day-of-month
      if (day !== "*") {
        const dayVals = day.split(",").flatMap((r) => {
          const range = r.match(/^(\d+)(?:-(\d+))?$/);
          if (!range) return [parseInt(r, 10)];
          const start = parseInt(range[1], 10);
          const end = range[2] ? parseInt(range[2], 10) : start;
          const result: number[] = [];
          for (let i = start; i <= Math.min(end, 31); i++) result.push(i);
          return result;
        });
        cand.setDate(dayVals[0] ?? 1);
      }

      // Check weekday
      if (weekday !== "*") {
        const weekdayVals = weekday.split(",").map((r) => parseInt(r, 10));
        // Adjust to find next matching weekday
        const start = new Date(cand);
        for (let d = 0; d < 7; d++) {
          const check = new Date(start);
          check.setDate(start.getDate() + d);
          if (weekdayVals.includes(check.getDay())) {
            cand.setDate(check.getDate());
            break;
          }
        }
      }

      if (cand.getTime() > baseMs) return cand;
    }
    return null;
  }

  return null;
}

function formatFireTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function CronLastRun({ job }: CronLastRunProps) {
  const lastRunMs = job.last_run ? new Date(job.last_run).getTime() : Date.now();
  const nextFire = computeNextFire(lastRunMs, job.schedule);

  return (
    <tr>
      <td colSpan={7} className="px-4 py-3 bg-gray-50 border-b border-gray-100">
        <div className="flex items-center gap-6 text-sm">
          {/* Last run */}
          <div className="flex items-center gap-2">
            <span className="text-gray-500">Last run:</span>
            {job.last_run ? (
              <span className="text-gray-700 font-mono text-xs">
                {formatFireTime(new Date(job.last_run))}
              </span>
            ) : (
              <span className="text-gray-400">never</span>
            )}
            {job.last_run_status === "ok" && (
              <CheckCircle className="w-4 h-4 text-green-600" />
            )}
            {job.last_run_status === "error" && (
              <XCircle className="w-4 h-4 text-red-600" />
            )}
            {!job.last_run_status && job.last_run && (
              <Minus className="w-4 h-4 text-gray-400" />
            )}
          </div>

          {/* Next scheduled */}
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-gray-500">Next scheduled:</span>
            {nextFire ? (
              <span className="text-gray-700 font-mono text-xs">
                {formatFireTime(nextFire)}
              </span>
            ) : (
              <span className="text-gray-400">—</span>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}
