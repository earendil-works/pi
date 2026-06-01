import { useState, useEffect } from "react";
import { X } from "lucide-react";
import { api } from "../lib/api";
import type { CronJob } from "../lib/api";

export type ScheduleKind = "at" | "every" | "cron";

export interface ScheduleValue {
  kind: ScheduleKind;
  time?: string; // for "at", format "HH:MM"
  interval?: number; // for "every", seconds
  expr?: string; // for "cron", cron expression
  tz?: string; // optional timezone for cron
}

interface CronFormProps {
  job?: CronJob; // undefined for create mode, defined for edit mode
  onClose: () => void;
  onSave?: (job: CronJob) => void;
}

function serializeSchedule(schedule: ScheduleValue): string {
  switch (schedule.kind) {
    case "at":
      return schedule.time || "00:00";
    case "every":
      return `${schedule.interval || 60}s`;
    case "cron":
      return schedule.expr || "* * * * *";
    default:
      return "* * * * *";
  }
}

function deserializeSchedule(schedule: string): ScheduleValue {
  // Try to parse as cron expression first
  const cronParts = schedule.split(" ");
  if (cronParts.length === 5) {
    return { kind: "cron", expr: schedule };
  }

  // Try to parse as interval (e.g., "60s")
  if (schedule.endsWith("s")) {
    const interval = parseInt(schedule.slice(0, -1), 10);
    if (!isNaN(interval)) {
      return { kind: "every", interval };
    }
  }

  // Try to parse as time (e.g., "09:00")
  if (/^\d{2}:\d{2}$/.test(schedule)) {
    return { kind: "at", time: schedule };
  }

  // Default fallback
  return { kind: "cron", expr: "* * * * *" };
}

export default function CronForm({ job, onClose, onSave }: CronFormProps) {
  const isEditMode = !!job;

  const [name, setName] = useState(job?.name || "");
  const [prompt, setPrompt] = useState(job?.prompt || "");
  const [scheduleValue, setScheduleValue] = useState<ScheduleValue>(
    job ? deserializeSchedule(job.schedule) : { kind: "cron", expr: "* * * * *" }
  );
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const input = {
        name,
        prompt,
        schedule: serializeSchedule(scheduleValue),
        enabled,
      };

      let savedJob: CronJob;
      if (isEditMode && job) {
        savedJob = await api.updateCronJob(job.id, input);
      } else {
        savedJob = await api.createCronJob(input);
      }

      onSave?.(savedJob);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save cron job");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">
            {isEditMode ? "Edit Cron Job" : "Create Cron Job"}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {error && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
              {error}
            </div>
          )}

          {/* Name */}
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
              Name
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="e.g., weekly-report"
            />
          </div>

          {/* Prompt */}
          <div>
            <label htmlFor="prompt" className="block text-sm font-medium text-gray-700 mb-1">
              Prompt
            </label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              required
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
              placeholder="Describe what this cron job should do..."
            />
          </div>

          {/* Schedule */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Schedule
            </label>
            <div className="space-y-3">
              {/* Radio buttons */}
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="schedule-kind"
                    value="at"
                    checked={scheduleValue.kind === "at"}
                    onChange={() => setScheduleValue({ ...scheduleValue, kind: "at", time: "09:00" })}
                    className="text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700">At time</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="schedule-kind"
                    value="every"
                    checked={scheduleValue.kind === "every"}
                    onChange={() => setScheduleValue({ ...scheduleValue, kind: "every", interval: 60 })}
                    className="text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700">Every</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="schedule-kind"
                    value="cron"
                    checked={scheduleValue.kind === "cron"}
                    onChange={() => setScheduleValue({ ...scheduleValue, kind: "cron", expr: "* * * * *" })}
                    className="text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700">Cron</span>
                </label>
              </div>

              {/* Dynamic sub-field */}
              <div className="pl-6">
                {scheduleValue.kind === "at" && (
                  <input
                    type="time"
                    value={scheduleValue.time || "09:00"}
                    onChange={(e) => setScheduleValue({ ...scheduleValue, time: e.target.value })}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                )}
                {scheduleValue.kind === "every" && (
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      value={scheduleValue.interval || 60}
                      onChange={(e) => setScheduleValue({ ...scheduleValue, interval: parseInt(e.target.value, 10) || 60 })}
                      className="w-24 px-3 py-2 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                    <span className="text-sm text-gray-600">seconds</span>
                  </div>
                )}
                {scheduleValue.kind === "cron" && (
                  <input
                    type="text"
                    value={scheduleValue.expr || "* * * * *"}
                    onChange={(e) => setScheduleValue({ ...scheduleValue, expr: e.target.value })}
                    placeholder="* * * * *"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm"
                  />
                )}
              </div>
            </div>
          </div>

          {/* Enabled */}
          <div className="flex items-center gap-2">
            <input
              id="enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
            />
            <label htmlFor="enabled" className="text-sm text-gray-700 cursor-pointer">
              Enabled
            </label>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Saving..." : isEditMode ? "Save" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
