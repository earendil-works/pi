import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import ChatPage from "./pages/ChatPage";
import CronPage from "./pages/CronPage";
import EmptyChat from "./pages/EmptyChat";
import { AppShell } from "./components/AppShell";
import { api, ws } from "./lib/api";
import type { SessionInfo } from "./lib/api";
import { useEffect, useState } from "react";

function ShellWrapper() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  async function loadSessions() {
    try { setSessions(await api.listSessions()); } catch {}
  }
  useEffect(() => { loadSessions(); }, []);

  async function handleNewChat() {
    setIsCreating(true);
    try {
      // createSession returns SessionInfo (id, title, status, lastActive, messageCount, cwd)
      const s = await api.createSession("");
      await loadSessions();
      window.location.href = `/session/${s.id}`;
    } catch (e) {
      console.error(e);
    } finally {
      setIsCreating(false);
    }
  }

  function handleDelete(id: string): void {
    api.deleteSession(id).then(() => loadSessions()).catch(console.error);
  }

  return (
    <AppShell
      version="0.1.0"
      sessions={sessions}
      filterQuery={filter}
      onFilterChange={setFilter}
      onSelectSession={(id: string) => { window.location.href = `/session/${id}`; }}
      onDeleteSession={handleDelete}
      onNewChat={handleNewChat}
      isCreatingChat={isCreating}
    >
      <Outlet />
    </AppShell>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<ShellWrapper />}>
          <Route path="/" element={<EmptyChat />} />
          <Route path="/session/:id" element={<ChatPage />} />
          <Route path="/cron" element={<CronPage />} />
          <Route path="/sessions" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
