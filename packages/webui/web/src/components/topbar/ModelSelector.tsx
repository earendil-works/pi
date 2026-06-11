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
  const [customModel, setCustomModel] = useState("");
  const [showCustomInput, setShowCustomInput] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Click outside handler
  useEffect(() => {
    function handleMouseDown(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setShowCustomInput(false);
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
    setShowCustomInput(false);
  };

  // For the current provider, if the picked model isn't in its models
  // list (e.g. models.json is out of date or the provider has no
  // models[]), surface it as a synthetic "(last used)" option so the
  // user can keep using it without manually typing.
  const currentProviderHasModel = providers.some(
    (p) => p.name === current.provider && p.models.some((m) => m.id === current.model),
  );
  const showCurrentAsSynthetic =
    current.model && !currentProviderHasModel;

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
        <div className="absolute right-0 mt-1 w-64 bg-white border rounded-md shadow-lg z-20 max-h-96 overflow-y-auto">
          {providers.map((provider) => (
            <div key={provider.name}>
              <div className="px-3 py-2 text-xs font-semibold text-stone-500 uppercase">
                {provider.name}
                {provider.models.length === 0 && (
                  <span className="ml-1 normal-case font-normal text-stone-400">
                    (no models in models.json)
                  </span>
                )}
              </div>
              {provider.models.length > 0 ? (
                provider.models.map((model) => {
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
                })
              ) : (
                // Provider exists but has no models in models.json. Show
                // the currently-selected model (if any) as a synthetic
                // option so the user can keep using what the session
                // already runs on, and a "use custom" input for typing
                // a model id the user knows works with this provider.
                <div>
                  {showCurrentAsSynthetic && current.provider === provider.name && (
                    <button
                      type="button"
                      onClick={() => handleModelSelect(provider.name, current.model)}
                      className="w-full text-left px-3 py-2 bg-blue-50 text-blue-900 hover:bg-blue-100"
                      title="Currently selected model (not in models.json)"
                    >
                      {current.model} <span className="text-xs text-stone-500">(current)</span>
                    </button>
                  )}
                  {showCustomInput ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const v = customModel.trim();
                        if (v) handleModelSelect(provider.name, v);
                      }}
                      className="px-3 py-2 flex gap-1"
                    >
                      <input
                        type="text"
                        value={customModel}
                        onChange={(e) => setCustomModel(e.target.value)}
                        placeholder="model id"
                        autoFocus
                        className="flex-1 min-w-0 text-sm border rounded px-2 py-1"
                      />
                      <button
                        type="submit"
                        className="text-xs bg-blue-600 text-white px-2 py-1 rounded"
                      >
                        Use
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowCustomInput(true)}
                      className="w-full text-left px-3 py-2 text-blue-600 hover:bg-stone-100 text-sm"
                    >
                      + Use custom model id
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
