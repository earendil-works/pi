/**
 * Config resolution for the tool-result pruner/spill extension.
 * Follows the validate-and-freeze pattern from dsh's compaction configs:
 * unknown keys throw (catch misspellings), nonsensical budgets throw,
 * resolved config is immutable.
 */

export interface ToolResultPrunerConfig {
  /** Prune text blocks strictly longer than this many code points. */
  pruneThresholdChars: number;
  pruneHeadChars: number;
  pruneTailChars: number;
  /** Spill text blocks strictly longer than this many code points to disk. */
  spillThresholdChars: number;
  spillPreviewHeadChars: number;
  spillPreviewTailChars: number;
  /** Directory for spilled files. "~" expanded at load. */
  spillDir: string;
  /** Delete spill files older than this many days (best-effort, on each spill). */
  retentionDays: number;
  /** Tool names whose results pass through untouched. */
  excludeTools: readonly string[];
  /** Master switch. */
  enabled: boolean;
  /** When true, prune-tier results (8K–50K) also write a spill file so the
   *  pruned middle is recoverable. Zero-loss pruning. */
  pruneSpillCopy: boolean;
}

export const DEFAULT_CONFIG: ToolResultPrunerConfig = {
  pruneThresholdChars: 8192,
  pruneHeadChars: 4096,
  pruneTailChars: 1024,
  spillThresholdChars: 50000,
  spillPreviewHeadChars: 4096,
  spillPreviewTailChars: 1024,
  spillDir: "~/.pi/agent/cache/tool-spill",
  retentionDays: 7,
  excludeTools: [],
  enabled: true,
  pruneSpillCopy: true,
};

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  "pruneThresholdChars",
  "pruneHeadChars",
  "pruneTailChars",
  "spillThresholdChars",
  "spillPreviewHeadChars",
  "spillPreviewTailChars",
  "spillDir",
  "retentionDays",
  "excludeTools",
  "enabled",
  "pruneSpillCopy",
]);

function assertPositiveInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`ToolResultPrunerConfig: ${name} (${String(value)}) must be a positive integer`);
  }
}

function assertNonNegativeInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`ToolResultPrunerConfig: ${name} (${String(value)}) must be a non-negative integer`);
  }
}

/**
 * Validate raw config (e.g. parsed from config.json) against defaults.
 * Throws on unknown keys or nonsensical budgets.
 */
export function resolveConfig(raw: Record<string, unknown>): ToolResultPrunerConfig {
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`ToolResultPrunerConfig: unknown key "${key}"`);
    }
  }

  const pruneThresholdChars = (raw.pruneThresholdChars ?? DEFAULT_CONFIG.pruneThresholdChars) as number;
  const pruneHeadChars = (raw.pruneHeadChars ?? DEFAULT_CONFIG.pruneHeadChars) as number;
  const pruneTailChars = (raw.pruneTailChars ?? DEFAULT_CONFIG.pruneTailChars) as number;
  const spillThresholdChars = (raw.spillThresholdChars ?? DEFAULT_CONFIG.spillThresholdChars) as number;
  const spillPreviewHeadChars = (raw.spillPreviewHeadChars ?? DEFAULT_CONFIG.spillPreviewHeadChars) as number;
  const spillPreviewTailChars = (raw.spillPreviewTailChars ?? DEFAULT_CONFIG.spillPreviewTailChars) as number;
  const retentionDays = (raw.retentionDays ?? DEFAULT_CONFIG.retentionDays) as number;

  assertPositiveInteger("pruneThresholdChars", pruneThresholdChars);
  assertNonNegativeInteger("pruneHeadChars", pruneHeadChars);
  assertNonNegativeInteger("pruneTailChars", pruneTailChars);
  assertPositiveInteger("spillThresholdChars", spillThresholdChars);
  assertNonNegativeInteger("spillPreviewHeadChars", spillPreviewHeadChars);
  assertNonNegativeInteger("spillPreviewTailChars", spillPreviewTailChars);
  assertNonNegativeInteger("retentionDays", retentionDays);

  if (pruneHeadChars + pruneTailChars > pruneThresholdChars) {
    throw new Error(
      `ToolResultPrunerConfig: pruneHeadChars + pruneTailChars (${pruneHeadChars + pruneTailChars}) ` +
      `must be at most pruneThresholdChars (${pruneThresholdChars})`,
    );
  }
  if (spillThresholdChars <= pruneThresholdChars) {
    throw new Error(
      `ToolResultPrunerConfig: spillThresholdChars (${spillThresholdChars}) must exceed ` +
      `pruneThresholdChars (${pruneThresholdChars}) — otherwise spill is unreachable`,
    );
  }

  const excludeToolsRaw = raw.excludeTools ?? DEFAULT_CONFIG.excludeTools;
  if (!Array.isArray(excludeToolsRaw) || excludeToolsRaw.some((t) => typeof t !== "string")) {
    throw new Error("ToolResultPrunerConfig: excludeTools must be an array of tool name strings");
  }

  const spillDir = raw.spillDir ?? DEFAULT_CONFIG.spillDir;
  if (typeof spillDir !== "string" || spillDir.length === 0) {
    throw new Error("ToolResultPrunerConfig: spillDir must be a non-empty string");
  }

  const enabled = raw.enabled ?? DEFAULT_CONFIG.enabled;
  if (typeof enabled !== "boolean") {
    throw new Error("ToolResultPrunerConfig: enabled must be a boolean");
  }

  const pruneSpillCopy = raw.pruneSpillCopy ?? DEFAULT_CONFIG.pruneSpillCopy;
  if (typeof pruneSpillCopy !== "boolean") {
    throw new Error("ToolResultPrunerConfig: pruneSpillCopy must be a boolean");
  }

  return Object.freeze({
    pruneThresholdChars,
    pruneHeadChars,
    pruneTailChars,
    spillThresholdChars,
    spillPreviewHeadChars,
    spillPreviewTailChars,
    spillDir,
    retentionDays,
    excludeTools: Object.freeze([...excludeToolsRaw]) as readonly string[],
    enabled,
    pruneSpillCopy,
  });
}
