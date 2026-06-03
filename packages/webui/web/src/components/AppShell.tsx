import type { ReactNode } from 'react';
import type { SessionInfo } from '../lib/api';
import { Brand } from './sidebar/Brand';
import { IconRow } from './sidebar/IconRow';
import { SearchBox } from './sidebar/SearchBox';
import { ConversationList } from './sidebar/ConversationList';
import { NewChatButton } from './sidebar/NewChatButton';

export interface AppShellProps {
  version: string;
  sessions: SessionInfo[];
  currentSessionId?: string;
  filterQuery: string;
  onFilterChange: (q: string) => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onNewChat: () => void;
  isCreatingChat?: boolean;
  children: ReactNode;
}

export function AppShell({
  version,
  sessions,
  currentSessionId,
  filterQuery,
  onFilterChange,
  onSelectSession,
  onDeleteSession,
  onNewChat,
  isCreatingChat,
  children,
}: AppShellProps) {
  return (
    <div className="flex h-full">
      <aside className="w-[260px] h-full border-r border-stone-200 flex flex-col bg-stone-50">
        <Brand version={version} />
        <IconRow activePage="chat" />
        <SearchBox value={filterQuery} onChange={onFilterChange} />
        <div className="flex-1 min-h-0 overflow-auto">
          <ConversationList
            sessions={sessions}
            currentId={currentSessionId}
            filterQuery={filterQuery}
            onSelect={onSelectSession}
            onDelete={onDeleteSession}
          />
        </div>
        <NewChatButton onClick={onNewChat} loading={isCreatingChat} />
      </aside>
      <main className="flex-1 overflow-auto flex flex-col">
        {children}
      </main>
    </div>
  );
}
