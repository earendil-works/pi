import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import ChatPage from "./pages/ChatPage";
import CronPage from "./pages/CronPage";
import EmptyChat from "./pages/EmptyChat";
import { AppShell } from "./components/AppShell";
import { api } from "./lib/api";
import type { SessionInfo } from "./lib/api";
import { useEffect, useState } from "react";

function ShellWrapper() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  async function loadSessions() {
    try { setSessions(await api.listSessions()); } catch {}
  }
  useEffect(() => { loadSessions(); }, []);

  async function handleNewChat() {
    setIsCreating(true);
    try {
      const s = await api.createSession("");
      setSessions((prev) => {
        if (prev.find((x) => x.id === s.id)) return prev;
        return [s, ...prev];
      });
      navigate(`/session/${s.id}`);
    } catch (e) {
      console.error(e);
    } finally {
      setIsCreating(false);
    }
  }

  function handleDelete(id: string): void {
    const wasCurrent = location.pathname === `/session/${id}`;
    api
      .deleteSession(id)
      .then(() => {
        setSessions((prev) => prev.filter((s) => s.id !== id));
        if (wasCurrent) navigate("/");
      })
      .catch((err) => {
        console.error("[App] deleteSession failed:", err);
        alert("Failed to delete session. Please try again.");
      });
  }

  function handleSelect(id: string): void {
    navigate(`/session/${id}`);
  }

  const currentSessionId = location.pathname.startsWith("/session/")
    ? location.pathname.split("/")[2]
    : undefined;

  return (
    <AppShell
      version="0.1.0"
      sessions={sessions}
      currentSessionId={currentSessionId}
      filterQuery={filter}
      onFilterChange={setFilter}
      onSelectSession={handleSelect}
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
