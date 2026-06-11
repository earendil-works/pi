import type { JSX } from "react";
import { formatRelativeTime } from "../../lib/format";

export interface MessageHeaderProps {
  name: string;
  timestamp: string;
  model?: string;
  provider?: string;
  avatarLetter?: string;
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + "…" : str;
}

// Format the model badge: "deepseek-v4-flash" alone, or
// "opencode-go/deepseek-v4-flash" when the provider isn't implied
// (e.g. a model name that exists in multiple providers).
function formatModelBadge(provider: string | undefined, model: string | undefined): string {
  if (!model) return "";
  // For now, the model id alone is unique enough to disambiguate within
  // this session. The provider is shown only if a `provider` is supplied
  // and the model is non-obvious (TODO: more sophisticated collision
  // detection; for the typical single-provider case this just shows the
  // model id).
  return provider ? `${provider}/${truncate(model, 24)}` : truncate(model, 24);
}

export function MessageHeader({
  name,
  timestamp,
  model,
  provider,
  avatarLetter,
}: MessageHeaderProps): JSX.Element {
  const letter = avatarLetter ?? (name[0]?.toUpperCase() ?? "?");
  const badge = formatModelBadge(provider, model);

  return (
    <div className="flex items-center gap-2 mb-1">
      <div className="w-6 h-6 rounded-full bg-blue-500 text-white flex items-center justify-center text-xs font-semibold">
        {letter}
      </div>
      <span className="text-sm font-semibold text-stone-900">{name}</span>
      <span className="text-xs text-stone-500">{formatRelativeTime(timestamp)}</span>
      {badge && (
        <span
          className="text-[10px] bg-stone-100 text-stone-700 px-1.5 py-0.5 rounded"
          title={provider && model ? `${provider}/${model}` : model}
        >
          {badge}
        </span>
      )}
    </div>
  );
}
