import { Plus, Loader2 } from 'lucide-react';

interface NewChatButtonProps {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
}

export function NewChatButton({ onClick, disabled, loading }: NewChatButtonProps) {
  return (
    <div className="p-3 border-t border-stone-200">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || loading}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <Plus size={16} />
        )}
        <span className="text-sm font-medium">New conversation</span>
      </button>
    </div>
  );
}
