import React from 'react';
import { formatToken } from '../../lib/format';

interface ContextIndicatorProps {
  // Last assistant turn's input token count — the size of the prompt pi
  // actually sent to the model on the most recent completion call. The
  // closest observable signal for "how much context did the model see";
  // summing across turns would double-count, so we report just the
  // latest turn. Hidden when no assistant turn has produced a usage
  // block yet — synthesising a "0" without history would be misleading.
  tokens?: number;
  // Optional total context window for the active model. When present,
  // the chip reads "used / total" so the user can see at a glance how
  // close the conversation is to compaction. When absent (model not in
  // models.json, or models.json has no contextWindow for it), the chip
  // falls back to a "used only" reading.
  contextWindow?: number;
}

/**
 * Pill-shaped chip that surfaces context usage in the topbar.
 *
 * Modes:
 *   - `tokens` only   → "52.4K ctx"        (model window unknown)
 *   - tokens + window → "203 / 200K ctx"   (preferred)
 *
 * Sits next to ModelSelector so it has the same visual weight as the
 * model badge. Earlier iterations put this in the gray subtitle text
 * and users couldn't find it. Colored chip makes the indicator a peer
 * of the model selector rather than a footnote.
 */
export function ContextIndicator({ tokens, contextWindow }: ContextIndicatorProps): React.JSX.Element | null {
  if (typeof tokens !== "number") return null;
  const hasWindow = typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0;
  const label = hasWindow
    ? `${formatToken(tokens)} / ${formatToken(contextWindow!)}`
    : formatToken(tokens);
  const title = hasWindow
    ? `Most recent prompt: ${tokens.toLocaleString()} of ${contextWindow!.toLocaleString()} tokens sent to the model`
    : "Most recent prompt size sent to the model";
  return (
    <span
      data-testid="context-tokens"
      title={title}
      className="text-sm bg-amber-100 text-amber-900 px-3 py-1 rounded-full font-medium tabular-nums"
    >
      {label} ctx
    </span>
  );
}
