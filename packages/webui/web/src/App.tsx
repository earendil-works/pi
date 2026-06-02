import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import ChatPage from "./pages/ChatPage";
import CronPage from "./pages/CronPage";
import EmptyChat from "./pages/EmptyChat";
import Sidebar from "./components/Sidebar";

function Layout() {
  return (
    <div className="flex h-full">
      <aside className="w-[260px] h-full border-r border-gray-200 flex flex-col p-4 gap-2">
        <div className="flex-1 min-h-0">
          <Sidebar
            onSelectSession={(id) => {
              window.location.href = `/session/${id}`;
            }}
            onNewChat={async () => {
              const { api } = await import("./lib/api");
              const s = await api.createSession("");
              window.location.href = `/session/${s.id}`;
            }}
          />
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<EmptyChat />} />
          <Route path="/session/:id" element={<ChatPage />} />
          <Route path="/cron" element={<CronPage />} />
          <Route path="/sessions" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
