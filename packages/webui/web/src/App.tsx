import { BrowserRouter, NavLink, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { Clock, MessageSquare } from "lucide-react";
import SessionsPage from "./pages/SessionsPage";
import ChatPage from "./pages/ChatPage";
import CronPage from "./pages/CronPage";

function Sidebar() {
  return (
    <aside className="w-[200px] h-full border-r border-gray-200 flex flex-col p-4 gap-2">
      <nav className="flex flex-col gap-1">
        <NavLink
          to="/sessions"
          className={({ isActive }) =>
            `flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
              isActive
                ? "bg-blue-100 text-blue-900"
                : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            }`
          }
        >
          <MessageSquare className="w-4 h-4" />
          Sessions
        </NavLink>
        <NavLink
          to="/cron"
          className={({ isActive }) =>
            `flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
              isActive
                ? "bg-blue-100 text-blue-900"
                : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            }`
          }
        >
          <Clock className="w-4 h-4" />
          Cron
        </NavLink>
      </nav>
    </aside>
  );
}

function Layout() {
  return (
    <div className="flex h-full">
      <Sidebar />
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
          <Route path="/" element={<Navigate to="/sessions" replace />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/chat/:id" element={<ChatPage />} />
          <Route path="/cron" element={<CronPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
