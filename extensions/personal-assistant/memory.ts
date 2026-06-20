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
//   - search.ts     — recallAtoms (used by the context-injection pipeline)
//   - format.ts     — formatMemoryContext (used by the context-injection pipeline)
//
// What memory.ts still owns:
//   - registerMemory(pi) — wires session_before_compact + session_start + the
//     before_agent_start / context memory-injection pipeline.
//   - loadConfig()       — reads personal-assistant config (graceful fallback to {})
//   - re-exports the v2 entry points / types so index.ts keeps its current shape
//
// Design decisions honoured here:
//   - session_before_compact uses extractMemoriesWithCallLlm (no ExtensionContext
//     dependency — the LLM call is supplied by the hook at call time).
//   - session_start decay is throttled to once per hour per process (DECAY_INTERVAL_MS)
//     so a chatty session does not thrash the DB.
//   - before_agent_start kicks off recallAtoms async and stashes the promise in
//     the module-level `pendingMemorySearch`; context awaits it (raced against
//     an 8s timeout) and injects the formatted block into the last user
//     message. Non-destructive: original event is returned if nothing to inject.
//   - loadConfig returns {} on any failure — never throws. Real config wiring
//     is external (see SettingsManager / webui routes).

import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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

/**
 * Per-turn memory-context pipeline state. The before_agent_start hook
 * kicks off `recallAtoms` async and stores the promise here; the context
 * hook awaits it (with an 8s race timeout) and injects the formatted
 * result into the last user message of the event.
 *
 * Module-level so the two hooks share the same in-flight search across
 * the same process. Cleared after the context hook reads it.
 */
type FormattedMemory = { text: string; used: number; included: number };
let pendingMemorySearch: Promise<FormattedMemory | null> | null = null;

/** Hard cap on how long the context hook waits for the recall to finish. */
const CONTEXT_RECALL_TIMEOUT_MS = 8_000;

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
 *
 *   - before_agent_start: fire-and-forget recall of relevant atoms for the
 *     incoming user prompt. Result is stashed in `pendingMemorySearch` for
 *     the context hook to pick up.
 *
 *   - context: await the pending recall (8s race) and inject the formatted
 *     memory block into the last user message of the event. Returns the
 *     original event unchanged when no memory should be injected.
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

	// before_agent_start — fire-and-forget recall of relevant atoms for the
	// incoming user prompt. The result is stashed in `pendingMemorySearch`
	// for the context hook to await on the same turn. Dynamic imports of
	// search.ts / format.ts keep the cold-start cost off the critical path
	// for sessions that never reach the context hook.
	pi.on("before_agent_start", async (event, _ctx) => {
		const userMessage = (event as { prompt?: string }).prompt ?? "";
		if (userMessage.length === 0) return;

		const config = loadConfig();
		const dbPath = config.memory?.dbPath ?? DEFAULT_DB_PATH;
		const atomsDir = config.memory?.atomsDir ?? DEFAULT_ATOMS_DIR;

		pendingMemorySearch = (async (): Promise<FormattedMemory | null> => {
			const index = new MemoryIndex(dbPath);
			await index.init();
			try {
				const { recallAtoms } = await import("./search.ts");
				const { formatMemoryContext } = await import("./format.ts");
				const results = await recallAtoms(index, userMessage, atomsDir, { topK: 10 });
				return formatMemoryContext(results, 4000);
			} finally {
				index.close();
			}
		})();
	});

	// context — await the pending recall (raced against an 8s timeout) and
	// inject the formatted memory block into the last user message of the
	// event. Non-destructive: the original event is returned unchanged if
	// there is no pending search, no formatted text, or no user message to
	// mutate. Modifications produce a fresh messages array — never the
	// caller's array reference.
	pi.on("context", async (event: ContextEvent, _ctx) => {
		const result = await injectMemoryContext(event, pendingMemorySearch);
		pendingMemorySearch = null;
		return result;
	});
}

/**
 * Build the context-event result for the memory injection pipeline.
 *
 * Extracted to its own typed function so the call site (`pi.on("context", …)`)
 * returns a value that satisfies the ExtensionHandler<ContextEvent,
 * ContextEventResult> contract without widening the lambda's inferred return
 * type into a shape the `on` overload set cannot reconcile (TS will otherwise
 * fall through to the `"input"` overload and complain).
 *
 * Returns:
 *   - the original event (cast to ContextEventResult) when no search is
 *     pending, the search produced no text, or no user message is present;
 *   - a fresh `{ messages: [...] }` object with the last user message
 *     prefixed by the formatted memory block otherwise.
 */
async function injectMemoryContext(
	event: ContextEvent,
	pending: Promise<FormattedMemory | null> | null,
): Promise<{ messages?: AgentMessage[] }> {
	if (!pending) return event as unknown as { messages?: AgentMessage[] };

	const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), CONTEXT_RECALL_TIMEOUT_MS));
	const formatted = await Promise.race([pending, timeout]);

	if (!formatted || !formatted.text) return event as unknown as { messages?: AgentMessage[] };

	const messages = (event.messages ?? []) as Array<{ role: string; content: string | unknown[] }>;
	if (!Array.isArray(messages) || messages.length === 0) return event as unknown as { messages?: AgentMessage[] };

	// Manual scan — Array.prototype.findLastIndex is ES2023, not in the
	// repo's tsconfig lib target.
	let lastUserIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			lastUserIdx = i;
			break;
		}
	}

	if (lastUserIdx === -1) return event as unknown as { messages?: AgentMessage[] };

	const lastUser = messages[lastUserIdx];
	const originalContent = typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content);
	const memoryPrefix = `[Relevant memory context]\n${formatted.text}\n\n[User message]\n`;
	const newContent = memoryPrefix + originalContent;

	const newMessages = [...messages];
	newMessages[lastUserIdx] = { ...lastUser, content: newContent };
	return { messages: newMessages as unknown as AgentMessage[] };
}