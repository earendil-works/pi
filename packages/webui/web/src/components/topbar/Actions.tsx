import React from 'react';
import { Trash2, Settings } from 'lucide-react';

interface ActionsProps {
  onClear: () => void;
  onSettings: () => void;
}

export function Actions({ onClear, onSettings }: ActionsProps): React.ReactElement {
  const handleClear = (): void => {
    if (window.confirm('Clear messages?')) {
      onClear();
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleClear}
        className="text-sm text-stone-500 hover:text-stone-700 hover:bg-stone-100 px-3 py-2 rounded-md flex items-center gap-1"
      >
        <Trash2 size={16} />
        Clear
      </button>
      <button
        type="button"
        onClick={onSettings}
        className="text-stone-500 hover:text-stone-700 hover:bg-stone-100 p-2 rounded-md"
        aria-label="Settings"
      >
        <Settings size={16} />
      </button>
    </div>
  );
}
