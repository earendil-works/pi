import { BrowserRouter, NavLink, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { Clock } from "lucide-react";
import type { ReactNode } from "react";
import ChatPage from "./pages/ChatPage";
import CronPage from "./pages/CronPage";
import EmptyChat from "./pages/EmptyChat";
import Sidebar from "./components/Sidebar";

const navLinkClassName = ({ isActive }: { isActive: boolean }): string =>
  `flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
    isActive
      ? "bg-blue-100 text-blue-900"
      : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
  }`;

function CronNavLink() {
  return (
    <NavLink to="/cron" className={navLinkClassName}>
      <Clock className="w-4 h-4" />
      Cron
    </NavLink>
  );
}

function Layout() {
  return (
    <div className="flex h-full">
      <aside className="w-[260px] h-full border-r border-gray-200 flex flex-col p-4 gap-2">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-lg font-semibold text-gray-900">pi webui</span>
        </div>
        <CronNavLink />
        <hr className="my-2 border-gray-200" />
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
