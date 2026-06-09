import { useState, useEffect } from "react";
import { X } from "lucide-react";

export interface AskUserQuestionModalProps {
  isOpen: boolean;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export default function AskUserQuestionModal({
  isOpen,
  question,
  options,
  multiSelect,
  onSubmit,
  onCancel,
}: AskUserQuestionModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Reset selection when modal opens
  useEffect(() => {
    if (isOpen) setSelected(new Set());
  }, [isOpen]);

  // Esc to cancel
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  function toggleOption(label: string) {
    const next = new Set(selected);
    if (multiSelect) {
      if (next.has(label)) next.delete(label);
      else next.add(label);
      setSelected(next);
    } else {
      next.clear();
      next.add(label);
      setSelected(next);
      // Auto-submit on single-select click
      onSubmit(label);
    }
  }

  /**
   * Single-select auto-submits on option click (toggleOption → onSubmit).
   * This Submit button exists as a keyboard-accessibility fallback for
   * multi-select mode and for users who tab to the button without selecting.
   */
  function handleSubmit() {
    const labels = options.map((o) => o.label);
    if (multiSelect) {
      // Preserve selection order by iterating options
      const chosen = labels.filter((l) => selected.has(l));
      onSubmit(chosen.join(", "));
    } else {
      // Single-select: if none picked, pick first; else pick the selected one
      const first = selected.values().next().value ?? labels[0] ?? "";
      onSubmit(first);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      aria-modal="true"
      role="dialog"
      data-testid="ask-user-question-modal"
    >
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-900">{question}</h2>
          <button
            onClick={onCancel}
            className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 py-4 max-h-96 overflow-auto">
          {options.map((opt) => {
            const isSelected = selected.has(opt.label);
            return (
              <label
                key={opt.label}
                className={`flex items-start gap-3 px-3 py-2 rounded-md cursor-pointer hover:bg-gray-50 ${
                  isSelected ? "bg-blue-50" : ""
                }`}
                data-option-label={opt.label}
              >
                <input
                  type={multiSelect ? "checkbox" : "radio"}
                  name={multiSelect ? undefined : "ask-question-option"}
                  checked={isSelected}
                  onChange={() => toggleOption(opt.label)}
                  className="mt-1"
                  data-testid={`option-${opt.label}`}
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-gray-900">{opt.label}</div>
                  {opt.description && (
                    <div className="text-xs text-gray-500 mt-0.5">{opt.description}</div>
                  )}
                </div>
              </label>
            );
          })}
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-lg">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={selected.size === 0}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
