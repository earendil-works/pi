import { Link, useLocation } from 'react-router-dom';
import { MessageSquare, Clock, Brain, Terminal } from 'lucide-react';

export function IconRow() {
  const location = useLocation();
  const isCron = location.pathname.startsWith('/cron');
  const isMemory = location.pathname.startsWith('/memory');
  const isCommands = location.pathname.startsWith('/commands');

  const linkClass = (active: boolean) =>
    `p-2 rounded-md transition-colors ${
      active
        ? 'bg-blue-100 text-blue-700'
        : 'text-stone-500 hover:bg-stone-100 hover:text-stone-700'
    }`;

  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b border-stone-100">
      <Link
        to="/"
        aria-label="Chat"
        className={linkClass(!isCron && !isMemory && !isCommands)}
      >
        <MessageSquare size={18} />
      </Link>
      <Link to="/cron" aria-label="Cron" className={linkClass(isCron)}>
        <Clock size={18} />
      </Link>
      <Link to="/memory" aria-label="Memory" className={linkClass(isMemory)}>
        <Brain size={18} />
      </Link>
      <Link to="/commands" aria-label="Quick Commands" className={linkClass(isCommands)}>
        <Terminal size={18} />
      </Link>
    </div>
  );
}
