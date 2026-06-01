import { useEffect, useState } from "react";
import { Clock, Plus, Eye, EyeOff } from "lucide-react";
import { api } from "../lib/api";
import type { CronJob } from "../lib/api";
import CronList from "../components/CronList";

export default function CronPage() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDisabled, setShowDisabled] = useState(true);

  useEffect(() => {
    fetchJobs();
  }, []);

  async function fetchJobs() {
    try {
      setLoading(true);
      setError(null);
      const data = await api.listCronJobs();
      setJobs(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load cron jobs");
    } finally {
      setLoading(false);
    }
  }

  async function handleToggle(id: string, enabled: boolean) {
    // Placeholder - will be wired in a later task
    console.log("Toggle", id, enabled);
  }

  async function handleTrigger(id: string) {
    // Placeholder - will be wired in a later task
    console.log("Trigger", id);
  }

  function handleEdit(job: CronJob) {
    // Placeholder - will be wired in a later task
    console.log("Edit", job);
  }

  async function handleDelete(id: string) {
    // Placeholder - will be wired in a later task
    console.log("Delete", id);
  }

  function handleNewCron() {
    // Placeholder - will be wired in a later task
    console.log("New Cron");
  }

  const filteredJobs = showDisabled ? jobs : jobs.filter((j) => j.enabled);

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Clock className="w-7 h-7 text-blue-600" />
          <h1 className="text-2xl font-bold text-gray-900">Cron Jobs</h1>
          {jobs.length > 0 && (
            <span className="px-2.5 py-0.5 rounded-full bg-gray-100 text-gray-600 text-sm">
              {jobs.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowDisabled(!showDisabled)}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50 transition-colors"
          >
            {showDisabled ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
            {showDisabled ? "Hide disabled" : "Show disabled"}
          </button>
          <button
            onClick={handleNewCron}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Cron
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      )}

      {error && (
        <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && (
        <CronList
          jobs={filteredJobs}
          onToggle={handleToggle}
          onTrigger={handleTrigger}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onNewCron={handleNewCron}
        />
      )}
    </div>
  );
}
