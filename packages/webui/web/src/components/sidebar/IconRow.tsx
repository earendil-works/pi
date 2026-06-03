import { MessageSquare, Clock } from 'lucide-react';

interface IconRowProps {
  activePage: 'chat' | 'cron';
}

export function IconRow({ activePage }: IconRowProps) {
  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b border-stone-100">
      <button
        type="button"
        aria-label="Chat"
        className={`p-2 rounded-md transition-colors ${
          activePage === 'chat'
            ? 'bg-blue-100 text-blue-700'
            : 'text-stone-500 hover:bg-stone-100 hover:text-stone-700'
        }`}
      >
        <MessageSquare size={18} />
      </button>
      <button
        type="button"
        aria-label="Cron"
        className={`p-2 rounded-md transition-colors ${
          activePage === 'cron'
            ? 'bg-blue-100 text-blue-700'
            : 'text-stone-500 hover:bg-stone-100 hover:text-stone-700'
        }`}
      >
        <Clock size={18} />
      </button>
    </div>
  );
}
