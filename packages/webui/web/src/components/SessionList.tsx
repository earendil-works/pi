import { useNavigate } from "react-router-dom";
import { MessageSquare, Plus, Loader2 } from "lucide-react";
import type { SessionInfo } from "../lib/api";

interface SessionListProps {
  sessions: SessionInfo[];
  isLoading: boolean;
  error: Error | null;
}

function formatLastActive(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function truncateTitle(title: string, maxLen = 30): string {
  if (title.length <= maxLen) return title;
  return title.slice(0, maxLen) + "…";
}

function StatusBadge({ status }: { status: SessionInfo["status"] }) {
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
        <Loader2 className="w-3 h-3 animate-spin" />
        running
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
        error
      </span>
    );
  }
  // idle
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
      idle
    </span>
  );
}

export default function SessionList({ sessions, isLoading, error }: SessionListProps) {
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400">
        <Loader2 className="w-6 h-6 animate-spin mr-2" />
        <span>Loading sessions…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-red-600 text-sm">
        Failed to load sessions: {error.message}
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4 text-gray-400">
        <MessageSquare className="w-12 h-12" />
        <p className="text-sm">No sessions yet</p>
        <button
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 transition-colors"
          onClick={() => navigate("/chat/new")}
        >
          <Plus className="w-4 h-4" />
          New Session
        </button>
      </div>
    );
  }

  // Show up to 50 sessions; basic overflow scroll
  const displayed = sessions.slice(0, 50);

  return (
    <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 120px)" }}>
      {displayed.map((session) => (
        <button
          key={session.id}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 border-b border-gray-100 transition-colors"
          onClick={() => navigate(`/chat/${session.id}`)}
        >
          <MessageSquare className="w-5 h-5 text-gray-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 truncate">
              {truncateTitle(session.title)}
            </p>
            <p className="text-xs text-gray-400">
              {formatLastActive(session.lastActive)}
            </p>
          </div>
          <StatusBadge status={session.status} />
        </button>
      ))}
      {sessions.length > 50 && (
        <p className="text-xs text-gray-400 text-center py-2">
          Showing 50 of {sessions.length} sessions
        </p>
      )}
    </div>
  );
}
