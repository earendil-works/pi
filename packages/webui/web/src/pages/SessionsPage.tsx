import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { api } from "../lib/api";
import type { SessionInfo } from "../lib/api";
import SessionList from "../components/SessionList";

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    api
      .listSessions()
      .then((data) => {
        if (!cancelled) {
          // Sort by lastActive descending
          const sorted = [...data].sort(
            (a, b) =>
              new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime()
          );
          setSessions(sorted);
          setIsLoading(false);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err);
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
        <h1 className="text-xl font-semibold text-gray-900">Sessions</h1>
        <button
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 transition-colors"
          onClick={() => {
            // Placeholder: modal is Task 11.2
          }}
        >
          <Plus className="w-4 h-4" />
          New Session
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        <SessionList sessions={sessions} isLoading={isLoading} error={error} />
      </div>
    </div>
  );
}
