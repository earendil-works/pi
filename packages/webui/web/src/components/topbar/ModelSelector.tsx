import { useState, useEffect, useRef } from "react";
import type { ModelsResponse } from "../../lib/api";

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "...";
}

interface ModelSelectorProps {
  current: { provider: string; model: string };
  providers: ModelsResponse["providers"];
  onChange: (selection: { provider: string; model: string }) => void;
}

export function ModelSelector({ current, providers, onChange }: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Click outside handler
  useEffect(() => {
    function handleMouseDown(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener("mousedown", handleMouseDown);
    }

    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [isOpen]);

  const handleModelSelect = (provider: string, modelId: string) => {
    onChange({ provider, model: modelId });
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="text-sm bg-blue-100 text-blue-900 px-3 py-1 rounded-full font-medium hover:bg-blue-200"
      >
        {current.provider}/{truncate(current.model, 16)}
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-1 w-64 bg-white border rounded-md shadow-lg z-20">
          {providers.map((provider) => (
            <div key={provider.name}>
              <div className="px-3 py-2 text-xs font-semibold text-stone-500 uppercase">
                {provider.name}
              </div>
              {provider.models.map((model) => {
                const isSelected =
                  current.provider === provider.name && current.model === model.id;
                return (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => handleModelSelect(provider.name, model.id)}
                    className={`w-full text-left px-3 py-2 hover:bg-stone-100 ${
                      isSelected ? "bg-blue-50 text-blue-900" : ""
                    }`}
                  >
                    {model.name}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
