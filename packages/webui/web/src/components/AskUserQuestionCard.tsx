import React from 'react';

export interface CardState {
  id: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  status: 'active' | 'disabled' | 'timeout';
  selected?: string;
  sessionId: string;
}

export interface AskUserQuestionCardProps {
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  status: 'active' | 'disabled' | 'timeout';
  selected?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function AskUserQuestionCard(props: AskUserQuestionCardProps) {
  const { question, options, multiSelect, status, selected, onSubmit, onCancel } = props;
  const isActive = status === 'active';
  const [inputValue, setInputValue] = React.useState('');

  const handleSubmitMulti = () => {
    const parts = inputValue.split(',').map((s) => s.trim()).filter(Boolean);
    const labels: string[] = [];
    for (const part of parts) {
      const idx = parseInt(part, 10) - 1;
      if (idx >= 0 && idx < options.length) {
        labels.push(options[idx].label);
      }
    }
    onSubmit(labels.join(', '));
  };

  const inactiveClass = 'opacity-50 pointer-events-none';

  return (
    <div className="border border-gray-200 rounded bg-white p-4">
      {/* Question */}
      <div className="font-medium mb-3">{question}</div>

      {/* Status text for disabled / timeout */}
      {!isActive && status === 'disabled' && selected !== undefined && (
        <div className="text-sm text-gray-500 mb-2">你的选择: {selected}</div>
      )}
      {!isActive && status === 'timeout' && (
        <div className="text-sm text-gray-500 mb-2">已超时</div>
      )}

      {/* Options */}
      <div className={`space-y-2 mb-3 ${!isActive ? inactiveClass : ''}`}>
        {options.map((opt, idx) =>
          isActive && !multiSelect ? (
            <button
              key={idx}
              type="button"
              onClick={() => onSubmit(opt.label)}
              className="w-full text-left p-3 border border-gray-200 rounded bg-white hover:bg-gray-50 transition-colors"
            >
              <div className="font-medium">{opt.label}</div>
              {opt.description && (
                <div className="text-sm text-gray-400 overflow-hidden break-words">{opt.description}</div>
              )}
            </button>
          ) : (
            <div
              key={idx}
              className="w-full text-left p-3 border border-gray-200 rounded bg-white"
            >
              <div className="font-medium">
                {multiSelect && isActive ? `${idx + 1}. ${opt.label}` : opt.label}
              </div>
              {opt.description && (
                <div className="text-sm text-gray-400 overflow-hidden break-words">{opt.description}</div>
              )}
            </div>
          ),
        )}
      </div>

      {/* Multi-select input + Submit */}
      {isActive && multiSelect && (
        <div className="flex gap-2 items-center mb-3">
          <input
            type="text"
            placeholder="输入选项编号,逗号分隔"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            className="flex-1 border border-gray-200 rounded px-3 py-1.5 text-sm"
          />
          <button
            type="button"
            onClick={handleSubmitMulti}
            className="px-3 py-1.5 bg-blue-500 text-white rounded text-sm hover:bg-blue-600 transition-colors"
          >
            提交
          </button>
        </div>
      )}

      {/* Cancel */}
      <div className="mt-2">
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
        >
          取消
        </button>
      </div>
    </div>
  );
}
