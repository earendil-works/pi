import {
  Play,
  Pencil,
  Trash2,
  Calendar,
  Clock,
  CheckCircle,
  XCircle,
  ChevronRight,
} from "lucide-react";
import { useState, Fragment } from "react";
import type { CronJob } from "../lib/api";
import CronLastRun from "./CronLastRun";

interface CronListProps {
  jobs: CronJob[];
  onToggle?: (id: string, enabled: boolean) => void;
  onTrigger?: (id: string) => void;
  onEdit?: (job: CronJob) => void;
  onDelete?: (id: string) => void;
  onNewCron?: () => void;
}

/** Humanize a cron expression into a readable string */
function humanizeSchedule(expr: string): string {
  // Common patterns
  if (expr === "* * * * *") return "every minute";
  if (expr === "0 * * * *") return "every hour";
  if (expr === "0 0 * * *") return "every day at midnight";
  if (expr === "0 9 * * *") return "every day at 09:00";
  if (expr === "0 12 * * *") return "every day at 12:00";
  if (expr === "0 18 * * *") return "every day at 18:00";
  if (expr === "0 9,18 * * *") return "every day at 09:00 and 18:00";
  if (expr === "*/5 * * * *") return "every 5 minutes";
  if (expr === "*/15 * * * *") return "every 15 minutes";
  if (expr === "*/30 * * * *") return "every 30 minutes";

  // Parse minute hour day month weekday
  const parts = expr.split(" ");
  if (parts.length !== 5) return expr;

  const [minute, hour, day, month, weekday] = parts;

  // Every day at specific time: 0 9 * * * -> "every day at 09:00"
  if (day === "*" && month === "*" && weekday === "*") {
    if (hour === "*") return `every minute at :${minute.padStart(2, "0")}`;
    if (minute === "*") return `every minute in hour`;
    const h = hour.padStart(2, "0");
    const m = minute.padStart(2, "0");
    return `every day at ${h}:${m}`;
  }

  // Weekly
  if (day === "*" && month === "*" && weekday !== "*") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayIndex = parseInt(weekday, 10);
    const dayName = days[dayIndex] || weekday;
    const h = hour.padStart(2, "0");
    const m = minute.padStart(2, "0");
    return `every ${dayName} at ${h}:${m}`;
  }

  // Fallback to raw expression
  return expr;
}

function formatTimestamp(ts: string | null | undefined): string {
  if (!ts) return "never";
  try {
    const date = new Date(ts);
    return date.toLocaleString();
  } catch {
    return ts;
  }
}

function StatusChip({ status }: { status?: "ok" | "error" }) {
  if (!status) return null;
  if (status === "ok") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700 text-xs">
        <CheckCircle className="w-3 h-3" />
        OK
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-xs">
      <XCircle className="w-3 h-3" />
      Error
    </span>
  );
}

export default function CronList({
  jobs,
  onToggle,
  onTrigger,
  onEdit,
  onDelete,
  onNewCron,
}: CronListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (jobs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-500">
        <Calendar className="w-12 h-12 mb-4 opacity-50" />
        <p className="mb-4 text-center">No scheduled tasks yet. Add one to get started.</p>
        {onNewCron && (
          <button
            onClick={onNewCron}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            + New Cron
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="overflow-auto max-h-[calc(100vh-200px)]">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-white border-b border-gray-200">
          <tr>
            <th className="px-4 py-3 text-left font-medium text-gray-600">Name</th>
            <th className="px-4 py-3 text-left font-medium text-gray-600">Schedule</th>
            <th className="px-4 py-3 text-center font-medium text-gray-600">Enabled</th>
            <th className="px-4 py-3 text-center font-medium text-gray-600">Status</th>
            <th className="px-4 py-3 text-left font-medium text-gray-600">Last Run</th>
            <th className="px-4 py-3 text-left font-medium text-gray-600">Created</th>
            <th className="px-4 py-3 text-right font-medium text-gray-600">Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const isExpanded = expandedId === job.id;
            return (
              <Fragment key={job.id}>
                <tr
                  className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : job.id)}
                >
                  <td className="px-4 py-3 font-medium text-gray-900">
                    <span className="inline-flex items-center gap-1.5">
                      <ChevronRight
                        className={`w-3.5 h-3.5 text-gray-400 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                      />
                      {job.name}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      {humanizeSchedule(job.schedule)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggle?.(job.id, !job.enabled);
                      }}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        job.enabled ? "bg-blue-600" : "bg-gray-300"
                      }`}
                      aria-label={job.enabled ? "Disable cron job" : "Enable cron job"}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                          job.enabled ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <StatusChip status={job.last_run_status} />
                  </td>
                  <td className="px-4 py-3 text-gray-500">{formatTimestamp(job.last_run)}</td>
                  <td className="px-4 py-3 text-gray-500">{formatTimestamp(job.created_at)}</td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => onTrigger?.(job.id)}
                        className="p-1.5 rounded hover:bg-gray-200 text-gray-600 transition-colors"
                        title="Trigger Now"
                      >
                        <Play className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => onEdit?.(job)}
                        className="p-1.5 rounded hover:bg-gray-200 text-gray-600 transition-colors"
                        title="Edit"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => onDelete?.(job.id)}
                        className="p-1.5 rounded hover:bg-red-100 text-red-600 transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
                {isExpanded && <CronLastRun job={job} />}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
