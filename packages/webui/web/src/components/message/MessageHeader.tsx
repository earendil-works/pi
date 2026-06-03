import type { JSX } from "react";
import { formatRelativeTime } from "../../lib/format";

export interface MessageHeaderProps {
  name: string;
  timestamp: string;
  model?: string;
  avatarLetter?: string;
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + "…" : str;
}

export function MessageHeader({
  name,
  timestamp,
  model,
  avatarLetter,
}: MessageHeaderProps): JSX.Element {
  const letter = avatarLetter ?? (name[0]?.toUpperCase() ?? "?");

  return (
    <div className="flex items-center gap-2 mb-1">
      <div className="w-6 h-6 rounded-full bg-blue-500 text-white flex items-center justify-center text-xs font-semibold">
        {letter}
      </div>
      <span className="text-sm font-semibold text-stone-900">{name}</span>
      <span className="text-xs text-stone-500">{formatRelativeTime(timestamp)}</span>
      {model && (
        <span className="text-[10px] bg-stone-100 text-stone-700 px-1.5 py-0.5 rounded">
          {truncate(model, 20)}
        </span>
      )}
    </div>
  );
}
