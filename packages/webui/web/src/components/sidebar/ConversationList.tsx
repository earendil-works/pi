import { MessageSquare, Trash2 } from 'lucide-react';
import type { SessionInfo } from '../../lib/api';

interface ConversationListProps {
  sessions: SessionInfo[];
  currentId?: string;
  filterQuery: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

function truncateTitle(title: string, maxLen = 30): string {
  if (title.length === 0) return 'New Chat';
  if (title.length <= maxLen) return title;
  return title.slice(0, maxLen) + '…';
}

export function ConversationList({
  sessions,
  currentId,
  filterQuery,
  onSelect,
  onDelete,
}: ConversationListProps) {
  const filteredSessions = sessions.filter((session) =>
    session.title.toLowerCase().includes(filterQuery.toLowerCase())
  );

  if (filteredSessions.length === 0) {
    return (
      <div className="px-3 py-2 text-sm text-stone-400">
        {filterQuery ? 'No matches found' : 'No sessions yet'}
      </div>
    );
  }

  return (
    <nav className="flex flex-col gap-1 p-2 overflow-y-auto">
      {filteredSessions.map((session) => {
        const isActive = currentId === session.id;
        const isTui = session.source === 'tui';
        return (
          <div
            key={session.id}
            className={`group flex items-center gap-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
              isActive
                ? 'bg-blue-100 text-blue-900'
                : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900'
            }`}
          >
            <button
              type="button"
              onClick={() => onSelect(session.id)}
              className="flex items-center gap-2 flex-1 min-w-0 text-left"
            >
              <MessageSquare className="w-4 h-4 shrink-0" />
              {isTui && (
                <span
                  className="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-stone-200 text-stone-600 uppercase tracking-wider"
                  title="Owned by the TUI; view-only in WebUI"
                >
                  TUI
                </span>
              )}
              <span className="truncate">{truncateTitle(session.title)}</span>
            </button>
            <button
              type="button"
              aria-label="Delete"
              onClick={() => onDelete(session.id)}
              className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-100 hover:text-red-600 transition-opacity shrink-0"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        );
      })}
    </nav>
  );
}
