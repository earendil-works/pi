/**
 * pi extension: tool-result pruner + spill
 *
 * Keeps model context lean without losing information:
 *  - Text results over `spillThresholdChars` (default 50k code points) are
 *    written to disk and replaced by a head+tail preview with a file locator.
 *  - Text results over `pruneThresholdChars` (default 8k) are pruned to
 *    head + marker + tail (middle dropped, like dsh's tool-result pruner).
 *  - Images and other content blocks are never touched.
 *
 * Calibrated on DeepSeek Harness defaults
 * (compaction-tool-result-pruner 8192/4096/1024; spill maxInlineBytes 50000).
 *
 * Config: optional config.json next to this file (see config.ts for keys).
 */
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { resolveConfig, type ToolResultPrunerConfig } from "./config.ts";
import { pruneText, codePointLength } from "./prune.ts";
import { spillText, writeSpillFile, type SpillDeps } from "./spill.ts";

/** What the handler may return to pi (subset of ToolResultEventResult). */
interface ToolResultModification {
  content: ToolResultEvent["content"];
}


/**
 * Build the tool_result handler. Pure apart from injected deps, so the
 * pipeline is fully testable without a running pi.
 */
/** In-memory telemetry counters, observable via /pruner-stats. */
export interface PrunerStats {
  pruned: number;
  spilled: number;
  pruneBytesSaved: number;
  spillBytesSaved: number;
}

export function createStats(): PrunerStats {
  return { pruned: 0, spilled: 0, pruneBytesSaved: 0, spillBytesSaved: 0 };
}

export function createToolResultHandler(
  config: ToolResultPrunerConfig,
  deps: Pick<SpillDeps, "fs" | "now">,
  stats?: PrunerStats,
) {
  return function handleToolResult(event: ToolResultEvent): ToolResultModification | undefined {
    try {
    if (!config.enabled) return undefined;
    if (config.excludeTools.includes(event.toolName)) return undefined;

    // Recovery reads: don't prune read results that target a spill file —
    // that would re-prune the content the model is trying to recover (loop).
    if (event.toolName === "read") {
      const path = (event.input as Record<string, unknown>)?.path;
      if (typeof path === "string" && path.startsWith(config.spillDir)) {
        return undefined;
      }
    }

    let changed = false;
    const content = event.content.map((block): ToolResultEvent["content"][number] => {
      if (block.type !== "text") return block;
      const text = block.text;

      if (codePointLength(text) > config.spillThresholdChars) {
        try {
          const spilled = spillText(
            text,
            {
              id: `${event.toolName}-${event.toolCallId}`,
              spillDir: config.spillDir,
              thresholdChars: config.spillThresholdChars,
              previewHeadChars: config.spillPreviewHeadChars,
              previewTailChars: config.spillPreviewTailChars,
              retentionDays: config.retentionDays,
            },
            { fs: deps.fs, now: deps.now },
          );
          changed = true;
          if (stats) {
            stats.spilled++;
            stats.spillBytesSaved += codePointLength(text) - codePointLength(spilled);
          }
          return { type: "text" as const, text: spilled };
        } catch {
          // disk failure: fall through to pruning so context stays bounded
        }
      }

      if (codePointLength(text) > config.pruneThresholdChars) {
        changed = true;
        let recovery: { spillPath?: string } | undefined;
        if (config.pruneSpillCopy) {
          try {
            const spillPath = writeSpillFile(
              text,
              { id: `${event.toolName}-${event.toolCallId}`, spillDir: config.spillDir, retentionDays: config.retentionDays },
              { fs: deps.fs, now: deps.now },
            );
            recovery = { spillPath };
          } catch {
            // disk failure: prune without spill copy — context still bounded
          }
        }
        const pruned = pruneText(
          text,
          { thresholdChars: config.pruneThresholdChars, headChars: config.pruneHeadChars, tailChars: config.pruneTailChars },
          recovery,
        );
        if (stats) {
          stats.pruned++;
          stats.pruneBytesSaved += codePointLength(text) - codePointLength(pruned);
        }
        return { type: "text" as const, text: pruned };
      }

      return block;
    });

    return changed ? { content } : undefined;
    } catch {
      // Fail open: any unexpected error passes the result through unmodified
      return undefined;
    }
  };
}

/** Read optional sibling config.json; missing file or read error → defaults. */
function loadSiblingConfig(): ToolResultPrunerConfig {
  try {
    const here = fileURLToPath(import.meta.url);
    const raw = JSON.parse(readFileSync(`${dirname(here)}/config.json`, "utf8"));
    return resolveConfig(raw);
  } catch {
    return resolveConfig({});
  }
}

/** Production filesystem deps: same wiring the extension registers with. */
export function createRuntimeDeps(): Pick<SpillDeps, "fs" | "now"> {
  return {
    fs: {
      mkdirSync: (p: string) => mkdirSync(p, { recursive: true }),
      writeFileSync,
      readdirSync,
      statSync,
      unlinkSync,
    },
    now: () => Date.now(),
  };
}

export default function toolResultPrunerExtension(pi: ExtensionAPI): void {
  let resolved = loadSiblingConfig();
  if (resolved.spillDir.startsWith("~")) {
    resolved = resolveConfig({ ...resolved, spillDir: resolved.spillDir.replace("~", homedir()) });
  }
  const stats = createStats();
  pi.on("tool_result", createToolResultHandler(resolved, createRuntimeDeps(), stats));
  pi.registerCommand("pruner-stats", {
    description: "Show tool-result pruner telemetry (pruned/spilled counts, chars saved)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `Pruner: ${stats.pruned} pruned (${stats.pruneBytesSaved} chars saved), ` +
        `${stats.spilled} spilled (${stats.spillBytesSaved} chars saved)`,
        "info",
      );
    },
  });
}
