import type { JSX } from "react";
import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { MessageSquare, Plus, Clock, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { SessionInfo } from "../lib/api";

const navLinkClassName = ({ isActive }: { isActive: boolean }): string =>
  `flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
    isActive
      ? "bg-blue-100 text-blue-900"
      : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
  }`;

interface SidebarProps {
  currentSessionId?: string;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  onDeleteSession?: (id: string) => void;
}

function truncateTitle(title: string, maxLen = 30): string {
  if (title.length === 0) return "New Chat";
  if (title.length <= maxLen) return title;
  return title.slice(0, maxLen) + "…";
}

export default function Sidebar({
  currentSessionId,
  onSelectSession,
  onNewChat,
}: SidebarProps): JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSessions() {
      try {
        const data = await api.listSessions();
        if (!cancelled) {
          setSessions(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e : new Error("Unknown error"));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    loadSessions();

    const interval = setInterval(loadSessions, 30_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  function handleDeleteSession(id: string) {
    const confirmed = window.confirm("Delete this session? This cannot be undone.");
    if (!confirmed) return;

    // Optimistic remove
    setSessions((prev) => prev.filter((s) => s.id !== id));

    // Fire-and-forget delete
    api.deleteSession(id).then(
      () => {
        // Success — already optimistically removed
      },
      (err) => {
        // Rollback on failure
        console.error("[Sidebar] deleteSession failed:", err);
        // Re-fetch to restore correct state
        api.listSessions().then((data) => setSessions(data), console.error);
        alert("Failed to delete session. Please try again.");
      }
    );
  }

  async function handleNewChat() {
    try {
      const newSession = await api.createSession("");
      // Optimistic add at top
      setSessions((prev) => [newSession, ...prev]);
      onSelectSession(newSession.id);
    } catch (err) {
      console.error("[Sidebar] createSession failed:", err);
    }
  }

  return (
    <aside className="w-[200px] h-full border-r border-gray-200 flex flex-col p-4 gap-2">
      {/* Brand */}
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-sm font-semibold text-gray-900">pi webui</span>
      </div>

      {/* Cron link */}
      <NavLink to="/cron" className={navLinkClassName}>
        <Clock className="w-4 h-4" />
        Cron
      </NavLink>

      <hr className="border-gray-200" />

      {/* Chats label */}
      <div className="px-3 py-1 text-xs font-medium text-gray-400 uppercase tracking-wider">
        Chats
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="px-3 py-2 text-sm text-gray-400">Loading...</div>
        ) : error ? (
          <div className="px-3 py-2 text-sm text-red-500">Failed to load</div>
        ) : sessions.length === 0 ? (
          <div className="px-3 py-2 text-sm text-gray-400">No sessions yet</div>
        ) : (
          <nav className="flex flex-col gap-1">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`group flex items-center gap-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  currentSessionId === s.id
                    ? "bg-blue-100 text-blue-900"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectSession(s.id)}
                  className="flex items-center gap-2 flex-1 min-w-0 text-left"
                >
                  <MessageSquare className="w-4 h-4 shrink-0" />
                  <span className="truncate">{truncateTitle(s.title)}</span>
                </button>
                <button
                  type="button"
                  aria-label="Delete"
                  onClick={() => handleDeleteSession(s.id)}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-100 hover:text-red-600 transition-opacity shrink-0"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </nav>
        )}
      </div>

      {/* New Chat button */}
      <button
        type="button"
        onClick={handleNewChat}
        className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
      >
        <Plus className="w-4 h-4" />
        New Chat
      </button>
    </aside>
  );
}
