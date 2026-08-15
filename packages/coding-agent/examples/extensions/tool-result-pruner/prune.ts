/**
 * Deterministic tool-result pruning: replace the middle of oversized text
 * with a marker, keeping head and tail. Modeled on DeepSeek Harness's
 * compaction-tool-result-pruner defaults (8192/4096/1024).
 */

export interface PruneConfig {
  /** Prune only when length strictly exceeds this many Unicode code points. */
  thresholdChars: number;
  headChars: number;
  tailChars: number;
}

/** Recovery info injected into the prune marker for zero-loss pruning. */
export interface RecoveryInfo {
  /** Path to the full-output spill file, if one was written. */
  spillPath?: string;
}

/** Marker substituted for the removed middle span. */
export function pruneMarker(
  omitted: number,
  elidedStart: number,
  elidedEnd: number,
  recovery?: RecoveryInfo,
  thresholdChars?: number,
): string {
  const span = `[${elidedStart}, ${elidedEnd})`;
  if (recovery?.spillPath) {
    return `\n\n[... middle pruned: ${omitted} code points omitted ${span}; full output at ${recovery.spillPath}; grep or slice to recover ...]\n\n`;
  }
  const thresholdHint = thresholdChars ? ` (under ${thresholdChars} chars)` : "";
  return `\n\n[... middle pruned: ${omitted} code points omitted ${span}; re-run narrower${thresholdHint} to recover ...]\n\n`;
}

/** Count Unicode code points without splitting surrogate pairs. */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** First n code points of text. */
function head(text: string, n: number): string {
  return Array.from(text).slice(0, n).join("");
}

/** Last n code points of text. */
function tail(text: string, n: number): string {
  const pts = Array.from(text);
  return pts.slice(Math.max(0, pts.length - n)).join("");
}

/**
 * Prune text over the configured threshold to head + marker + tail.
 * Content at or under the threshold is returned unchanged.
 * When recovery.spillPath is provided, the marker includes the file path
 * so the model can grep/slice the full output to recover elided content.
 */
export function pruneText(text: string, config: PruneConfig, recovery?: RecoveryInfo): string {
  const length = codePointLength(text);
  if (length <= config.thresholdChars) {
    return text;
  }
  const omitted = length - config.headChars - config.tailChars;
  const elidedStart = config.headChars;
  const elidedEnd = length - config.tailChars;
  // Short prefix at position 0 so compaction's 2000-char serialization preserves
  // the recovery path. The full marker with offsets stays in the middle.
  const prefix = recovery?.spillPath
    ? `[pruned — full output at ${recovery.spillPath}; grep to recover]\n\n`
    : `[pruned — re-run narrower (under ${config.thresholdChars} chars) to recover]\n\n`;
  return prefix + head(text, config.headChars) + pruneMarker(omitted, elidedStart, elidedEnd, recovery, config.thresholdChars) + tail(text, config.tailChars);
}
