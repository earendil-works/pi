import { Link, useLocation } from 'react-router-dom';
import { MessageSquare, Clock } from 'lucide-react';

export function IconRow() {
  const location = useLocation();
  const isCron = location.pathname.startsWith('/cron');

  const linkClass = (active: boolean) =>
    `p-2 rounded-md transition-colors ${
      active
        ? 'bg-blue-100 text-blue-700'
        : 'text-stone-500 hover:bg-stone-100 hover:text-stone-700'
    }`;

  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b border-stone-100">
      <Link to="/" aria-label="Chat" className={linkClass(!isCron)}>
        <MessageSquare size={18} />
      </Link>
      <Link to="/cron" aria-label="Cron" className={linkClass(isCron)}>
        <Clock size={18} />
      </Link>
    </div>
  );
}
