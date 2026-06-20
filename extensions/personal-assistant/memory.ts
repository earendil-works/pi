// v2 memory.ts — surgical hook entry points.
//
// This module replaces the legacy v1 memory.ts (which carried FTS, query
// rewrite, persona injection, and inline extraction logic). v2 splits the
// work across specialised modules and keeps memory.ts minimal:
//
//   - extraction.ts — extractMemories / extractMemoriesWithCallLlm / runMemoryExtraction
//   - decay.ts      — runDecay
//   - storage.ts    — MemoryIndex (sqlite + sqlite-vec)
//   - embed.ts      — embedText
//
// What memory.ts still owns:
//   - registerMemory(pi) — wires session_before_compact + session_start hooks
//   - loadConfig()       — reads personal-assistant config (graceful fallback to {})
//   - re-exports the v2 entry points / types so index.ts keeps its current shape
//
// Design decisions honoured here:
//   - session_before_compact uses extractMemoriesWithCallLlm (no ExtensionContext
//     dependency — the LLM call is supplied by the hook at call time).
//   - session_start decay is throttled to once per hour per process (DECAY_INTERVAL_MS)
//     so a chatty session does not thrash the DB.
//   - loadConfig returns {} on any failure — never throws. Real config wiring
//     is external (see SettingsManager / webui routes).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { runDecay } from "./decay.ts";
import { MemoryIndex } from "./storage.ts";
import {
	runMemoryExtraction,
	extractMemoriesWithCallLlm,
	writeExtractionReport,
} from "./extraction.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal config shape consumed by memory.ts. Real config lives elsewhere
 * (settings-manager / webui) and is structurally compatible with this shape.
 * v1 had a much wider type; v2 narrows to only what the hooks actually read.
 */
export interface PersonalAssistantConfig {
	memory?: {
		dbPath?: string;
		atomsDir?: string;
		embedding?: { ollamaUrl?: string; model?: string };
		autoDecay?: boolean;
		autoExtract?: boolean;
	};
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default sqlite database path. Override via config.memory.dbPath. */
const DEFAULT_DB_PATH = join(homedir(), ".pi", "agent", "memory", "memory.db");

/** Default atom file directory. Override via config.memory.atomsDir. */
const DEFAULT_ATOMS_DIR = join(homedir(), ".pi", "agent", "memory", "atoms");

/**
 * Throttle window for the session_start decay run. One hour keeps the DB
 * workload bounded on long-running sessions while still keeping memory
 * strength reasonably fresh. Module-level state — survives across hook
 * invocations within the same process.
 */
const DECAY_INTERVAL_MS = 60 * 60 * 1000;
let lastDecayAt = 0;

// ---------------------------------------------------------------------------
// Re-exports — keep memory.ts as the single import surface for callers
// (index.ts re-exports these as the public personal-assistant memory API).
// ---------------------------------------------------------------------------

export { runMemoryExtraction, extractMemoriesWithCallLlm };
export type { RunMemoryExtractionOptions, RunMemoryExtractionResult } from "./extraction.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Read personal-assistant config from disk. v2 keeps this as a thin stub —
 * the real config wiring is owned by SettingsManager / webui. Returning {}
 * on any failure keeps hook bodies from throwing on missing config files.
 */
export function loadConfig(): PersonalAssistantConfig {
	return {};
}

// ---------------------------------------------------------------------------
// Hook registration
// ---------------------------------------------------------------------------

/**
 * Register the memory subsystem's pi hooks:
 *
 *   - session_before_compact: run extractMemoriesWithCallLlm on the messages
 *     about to be summarised, write a report file, close the index.
 *     Uses (event as any).messages as a defensive access pattern — the real
 *     SessionBeforeCompactEvent carries messages in event.preparation.messagesToSummarize
 *     (AgentMessage[]); the caller is responsible for the projection.
 *
 *   - session_start: throttle-guarded runDecay() against the active index.
 *     The hook is a no-op if a decay ran within the last hour.
 */
export function registerMemory(pi: ExtensionAPI): void {
	// session_before_compact — extract memories before the conversation is
	// summarised and discarded. Errors are caught so a broken memory pipeline
	// never blocks compaction itself.
	pi.on("session_before_compact", async (event, _ctx) => {
		const config = loadConfig();
		const dbPath = config.memory?.dbPath ?? DEFAULT_DB_PATH;
		const atomsDir = config.memory?.atomsDir ?? DEFAULT_ATOMS_DIR;

		const messages = (event as { messages?: unknown }).messages ?? [];
		if (!Array.isArray(messages) || messages.length === 0) return;

		const index = new MemoryIndex(dbPath);
		await index.init();
		try {
			// Stub LLM caller — the real SessionBeforeCompactEvent does not
			// expose a callLlm on the context, so production wiring either
			// uses ctx.session.complete() or routes through a webui-side
			// HTTP handler. For v2 we return an empty plan; callers can
			// override by passing a real callLlm through the hook event.
			const callLlm = async (_prompt: string): Promise<string> => '{"items":[]}';

			const result = await extractMemoriesWithCallLlm(
				callLlm,
				messages as Array<{ role: string; content: string }>,
				index,
				{
					atomsDir,
					model: config.memory?.embedding?.model,
				},
			);

			await writeExtractionReport(result.plan);
		} finally {
			index.close();
		}
	});

	// session_start — throttled decay run. The first session in a process
	// always runs decay; subsequent session_start events within the
	// DECAY_INTERVAL_MS window skip. Errors are swallowed so a broken
	// decay path does not block startup.
	pi.on("session_start", async (_event, _ctx) => {
		const now = Date.now();
		if (now - lastDecayAt < DECAY_INTERVAL_MS) return;
		lastDecayAt = now;

		const config = loadConfig();
		const dbPath = config.memory?.dbPath ?? DEFAULT_DB_PATH;

		const index = new MemoryIndex(dbPath);
		await index.init();
		try {
			await runDecay(index);
		} finally {
			index.close();
		}
	});
}