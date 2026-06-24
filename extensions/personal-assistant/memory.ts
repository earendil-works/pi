// v2 memory.ts — surgical hook entry points.
//
// This module replaces the legacy v1 memory.ts (which carried FTS, query
// rewrite, persona injection, and inline extraction logic). v2 splits the
// work across specialised modules and keeps memory.ts minimal:
//
//   - extraction.ts — extractMemoriesWithCallLlm / runMemoryExtraction
//   - decay.ts      — runDecay
//   - storage.ts    — MemoryIndex (sqlite + sqlite-vec)
//   - embed.ts      — embedText
//   - search.ts     — recallAtoms (discovery-only; results carry `id` + `score`)
//   - format.ts     — formatMemoryContext (renders summaries + id blocks for memory_get routing)
//
// What memory.ts still owns:
//   - registerMemory(pi) — wires session_before_compact + session_start + the
//     before_agent_start / context memory-injection pipeline + the `memory_get`
//     tool. The tool is the ONLY programmatic entry point that records
//     strength feedback for a specific atom (bump `access_count` /
//     `last_access` via `index.updateAccess`). Search does NOT bump — see
//     search.ts for the discovery-only invariant.
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
//     an 8s timeout) and injects the formatted block (summary + id per atom)
//     into the last user message. The LLM calls `memory_get(id)` to fetch the
//     full body — that call is the sole programmatic strength-feedback signal.
//     Non-destructive: original event is returned if nothing to inject.
//   - `memory_get` is registered as a tool on `pi` so the agent can explicitly
//     hydrate a search result. The execute body opens a fresh `MemoryIndex`,
//     looks up the atom, and ONLY on a successful hit calls `index.updateAccess`
//     — that bump is the sole programmatic strength-feedback signal. Missing
//     atoms return a "not found" result without writing anything.
//   - loadConfig returns {} on any failure — never throws. Real config wiring
//     is external (see SettingsManager / webui routes).

import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, completeSimple } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { runDecay } from "./decay.ts";
import { MemoryIndex } from "./storage.ts";
import {
	runMemoryExtraction,
	extractMemoriesWithCallLlm,
	writeExtractionReport,
} from "./extraction.ts";
import type { MemoryAtomType, RecallResult } from "./types.ts";

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
		enabled?: boolean;
		dbPath?: string;
		atomsDir?: string;
		/** Provider + model id used by `session_before_compact` to extract
		 *  atoms from the conversation. Distinct from `embedding.model` —
		 *  extraction is a chat completion (large context, JSON-mode-ish
		 *  output), embedding is a vector encoder. Defaults fall back to
		 *  the session model when omitted. */
		extraction?: { provider: string; model: string };
		/** Provider + model used by `before_agent_start` to rewrite the
		 *  user prompt into a search-friendly query. Local-only by default
		 *  (qwen2.5:3b) — cheap and avoids round-tripping the main agent. */
		queryRewrite?: { provider: string; model: string };
		embedding?: { ollamaUrl?: string; model?: string; provider?: string };
		decay?: { baseDecay?: number; archiveThreshold?: number };
		injection?: { maxCount?: number };
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
 * Flatten an AgentMessage into the {role, content: string} shape that
 * `extractMemoriesWithCallLlm` consumes. Returns null for messages we can't
 * flatten (no text content — e.g. image-only user messages, tool-only
 * assistant turns). The caller filters nulls before passing to extraction.
 */
function agentMessageToExtractionMessage(msg: AgentMessage): {
	role: string;
	content: string;
} | null {
	const role = (msg as { role?: string }).role;
	if (role !== "user" && role !== "assistant") return null;
	const content = (msg as { content: unknown }).content;
	if (typeof content === "string") {
		return content.length === 0 ? null : { role, content };
	}
	if (!Array.isArray(content)) return null;
	const textParts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && "type" in block && (block as { type: string }).type === "text") {
			const t = (block as { text?: unknown }).text;
			if (typeof t === "string" && t.length > 0) textParts.push(t);
		}
	}
	if (textParts.length === 0) return null;
	return { role, content: textParts.join("\n") };
}

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
// Per-prompt pending searches. Module-level Map (not single var) so two
// concurrent turns with different prompts don't stomp each other's recall.
// Same-prompt concurrent turns remain a theoretical race; pi's
// single-user runtime makes this vanishingly rare.
let pendingMemorySearches = new Map<string, Promise<FormattedMemory | null>>();

/** Hard cap on how long the context hook waits for the recall to finish. */
const CONTEXT_RECALL_TIMEOUT_MS = 8_000;

// ---------------------------------------------------------------------------
// memory_get tool schema
// ---------------------------------------------------------------------------

/**
 * TypeBox schema for the `memory_get` tool. `id` is a UUID produced by the
 * memory pipeline (see storage.ts `crypto.randomUUID()`); the LLM gets this
 * id from a `recallAtoms` search result and passes it back to hydrate the
 * atom's full content. Defined at module level so the schema object is
 * stable across `registerMemory` invocations (extension reloads).
 */
const MemoryGetParams = Type.Object({
	id: Type.String({ description: "Atom UUID from a search result" }),
});

/**
 * Discriminated details payload for the `memory_get` tool. Two variants:
 *   - success: every field the LLM may want from a hydrated atom.
 *   - not_found: explicit "no such atom" signal so callers can branch on
 *     `details.error` without parsing the content text.
 */
type MemoryGetDetails =
	| {
			error: "not_found";
			id: string;
	  }
	| {
			id: string;
			type: MemoryAtomType;
			title: string;
			content: string;
			summary: string;
			tags: string[];
			importance: number;
	  };

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
 * Read personal-assistant config from disk. Mirrors webui server's
 * `loadSettings()` (packages/webui/server/index.ts:63) — both consumers
 * need the same `~/.pi/agent/settings.json` shape. Returning {} on any
 * failure keeps hook bodies from throwing on missing config files; hook
 * bodies are responsible for treating a missing/empty config as
 * "extraction not configured" and surfacing that to the user.
 */
export function loadConfig(): PersonalAssistantConfig {
	try {
		const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
		if (!existsSync(settingsPath)) return {};
		const raw = readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw) as { personalAssistant?: PersonalAssistantConfig };
		return settings.personalAssistant ?? {};
	} catch {
		return {};
	}
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
	// Reset per-session state. The Map is module-level (so the two hooks
	// share it), but each registerMemory call gets a fresh map so test
	// runs and extension reloads don't leak state between each other.
	pendingMemorySearches = new Map();

// session_before_compact — extract memories before the conversation is
	// summarised and discarded. Fires on both manual /compact and auto-compact
	// (token-threshold trigger). Errors are caught so a broken memory pipeline
	// never blocks compaction itself.
	//
	// The event payload (SessionBeforeCompactEvent) carries the messages to
	// summarise at `event.preparation.messagesToSummarize`, not at
	// `event.messages` (which doesn't exist on this event). The extraction
	// prompt is fully self-contained — EXTRACT_PROMPT_V2 + tone hint + the
	// messages — so we use `completeSimple` with a single user-role message
	// carrying the prompt, matching how the webui server routes manual
	// extraction (`packages/webui/server/index.ts` buildCallLlm).
	//
	// The LLM caller is **config-driven** (settings.json
	// `personalAssistant.memory.extraction.{provider,model}`), NOT the
	// session's ctx.model. This is the same pattern the webui server
	// buildCallLlm uses, and it decouples extraction cost/quality from the
	// session's main model — the user can run a cheap local qwen2.5 for
	// extraction while keeping a strong Anthropic/GPT model for the agent
	// loop.
	//
	// Extraction is a **hard gate** for compact: if extraction throws (no
	// config, model not in registry, no auth, LLM call failed), the hook
	// returns `{cancel: true}` so compact does NOT proceed. The rationale
	// is that compact discards messages — discarding without preserving
	// the learnings in memory would silently degrade the memory subsystem
	// over the session's lifetime. Better to fail loudly: ctx.ui.notify
	// surfaces the specific error, the user fixes the config (or retries
	// /compact after a transient network blip clears), and the next
	// compact succeeds. Early-return paths inside runCompactExtraction
	// (empty messagesToSummarize, all messages filter out as no-text) do
	// NOT throw — they return normally, and the hook returns undefined,
	// so compact proceeds when there is genuinely nothing to extract.
	pi.on("session_before_compact", async (event, ctx) => {
		try {
			await runCompactExtraction(event, ctx);
			return undefined;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// eslint-disable-next-line no-console
			console.warn(
				"[memory-v2] session_before_compact: extraction failed, cancelling compact:",
				msg,
			);
			try {
				ctx.ui?.notify?.(
					`memory: extraction failed, compact cancelled — ${msg}`,
					"error",
				);
			} catch {
				// notify is best-effort; some ctx shapes (rpc/print) lack it
			}
			return { cancel: true };
		}
	});

	// Compact extraction — config-driven model + loud error surfacing.
	// Extracted from the hook body so the try/catch wrap above stays
	// readable and the resolver logic doesn't drown in indentation.
	async function runCompactExtraction(event: unknown, ctx: any): Promise<void> {
		const config = loadConfig();
		const dbPath = config.memory?.dbPath ?? DEFAULT_DB_PATH;
		const atomsDir = config.memory?.atomsDir ?? DEFAULT_ATOMS_DIR;

		// 1. Resolve the configured extraction model. If the user has not
		// configured `personalAssistant.memory.extraction`, this is a
		// config error — surface it loudly so they can fix settings.json
		// before the next /compact, instead of wondering why memory stopped
		// growing.
		const extractionCfg = config.memory?.extraction;
		if (!extractionCfg?.provider || !extractionCfg?.model) {
			throw new Error(
				"no extraction model configured: set personalAssistant.memory.extraction.{provider,model} in settings.json",
			);
		}

		const model = ctx.modelRegistry?.find?.(extractionCfg.provider, extractionCfg.model);
		if (!model) {
			throw new Error(
				`extraction model not in registry: ${extractionCfg.provider}/${extractionCfg.model} (check ` +
					`~/.pi/agent/settings.json and ~/.pi/agent/models.json)`,
			);
		}

		// 2. Auth via the same modelRegistry path pi's agent loop uses. This
		// honours the auth storage, env vars, and provider config overrides
		// uniformly. Throws with a specific error if the provider has no key
		// (e.g. user ran /login but never finished).
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			throw new Error(`extraction model auth: ${auth.error}`);
		}

		// 3. Source messages — real field on SessionBeforeCompactEvent.
		const rawMessages = (event as { preparation?: { messagesToSummarize?: unknown[] } })
			.preparation?.messagesToSummarize ?? [];
		if (!Array.isArray(rawMessages) || rawMessages.length === 0) return;

		// Convert AgentMessage → the simple {role, content: string} shape
		// that extractMemoriesWithCallLlm expects. User messages may be
		// string or (TextContent|ImageContent)[]; assistant messages are
		// arrays of TextContent/ThinkingContent/ToolCall. We flatten to text
		// only — images and tool calls don't help the extraction LLM.
		const messages = (rawMessages as unknown[])
			.map((m) => agentMessageToExtractionMessage(m as AgentMessage))
			.filter((m): m is { role: string; content: string } => m !== null);
		if (messages.length === 0) return;

		// 4. Build the callLlm closure. Auth header convention is decided
		// by the model.api, not the provider name (provider name = "opencode"
		// could route through anthropic-messages or openai-completions).
		const authHeader = model.api === "anthropic-messages" ? "x-api-key" : "Authorization";
		const headers: Record<string, string> = {
			...(model.headers ?? {}),
			...(auth.headers ?? {}),
		};
		if (auth.apiKey) {
			headers[authHeader] = authHeader === "Authorization" ? `Bearer ${auth.apiKey}` : auth.apiKey;
		}

		const callLlm = async (prompt: string): Promise<string> => {
			const response = await completeSimple(
				model,
				{ messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
				{ apiKey: auth.apiKey, headers, maxTokens: 2048 },
			);
			if (!response.content) {
				throw new Error("No content in LLM response");
			}
			const textParts: string[] = [];
			for (const c of response.content) {
				if (c.type === "text" && "text" in c) {
					textParts.push(c.text);
				}
			}
			if (textParts.length === 0) {
				throw new Error("No text content in LLM response");
			}
			return textParts.join("");
		};

		// 5. Run extraction. MemoryIndex self-heals its parent dir
		// (storage.ts) so a fresh ~/.pi/agent/memory/ works.
		const index = new MemoryIndex(dbPath);
		await index.init();
		try {
			const result = await extractMemoriesWithCallLlm(callLlm, messages, index, {
				atomsDir,
				model: config.memory?.embedding?.model,
			});
			await writeExtractionReport(result.plan);
		} finally {
			index.close();
		}
	}

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
	//
	// Surfaces a per-turn footer status (`memory` key) via `ctx.ui.setStatus`
	// so the user sees "📦 N atoms · rule=X fact=Y process=Z · top=0.XXX" in
	// the TUI status bar below the mode chip. Three observable states:
	//   - hits found       → "📦 N atoms · rule=… fact=… process=… · top=0.XXX"
	//   - empty recall     → "🔍 no memory match"
	//   - recall failed    → "⚠ memory recall failed"
	// The status reflects the most recent recall; older statuses are not
	// remembered (no separate key per turn — single source of truth).
	pi.on("before_agent_start", async (event, ctx) => {
		const userMessage = (event as { prompt?: string }).prompt ?? "";
		if (userMessage.length === 0) return;

		const config = loadConfig();
		const dbPath = config.memory?.dbPath ?? DEFAULT_DB_PATH;
		const atomsDir = config.memory?.atomsDir ?? DEFAULT_ATOMS_DIR;

		const promise = (async (): Promise<FormattedMemory | null> => {
			const index = new MemoryIndex(dbPath);
			await index.init();
			try {
				const { recallAtoms } = await import("./search.ts");
				const { formatMemoryContext } = await import("./format.ts");
				let results: RecallResult[];
				try {
					results = await recallAtoms(index, userMessage, { topK: 10 });
				} catch (err) {
					ctx.ui.setStatus("memory", "⚠ memory recall failed");
					throw err;
				}
				if (results.length === 0) {
					ctx.ui.setStatus("memory", "🔍 no memory match");
				} else {
					const byType = { rule: 0, fact: 0, process: 0 };
					for (const r of results) byType[r.atom.type]++;
					const topScore = results
						.map((r) => r.score)
						.reduce((a, b) => (b > a ? b : a), 0)
						.toFixed(3);
					ctx.ui.setStatus(
						"memory",
						`📦 ${results.length} atoms · rule=${byType.rule} fact=${byType.fact} process=${byType.process} · top=${topScore}`,
					);
				}
				return formatMemoryContext(results, 4000);
			} finally {
				index.close();
			}
		})();
		// Key by prompt to avoid stomping between concurrent turns. If a
		// context hook arrives for a different prompt, it won't see this
		// promise. (The hook reads by matching the event's last user
		// message content against pending keys.)
		pendingMemorySearches.set(userMessage, promise);
	});

	// context — await the pending recall (raced against an 8s timeout) and
	// inject the formatted memory block into the last user message of the
	// event. Non-destructive: the original event is returned unchanged if
	// there is no pending search, no formatted text, or no user message to
	// mutate. Modifications produce a fresh messages array — never the
	// caller's array reference.
	pi.on("context", async (event: ContextEvent, _ctx) => {
		// Find the pending search by matching against the last user message
		// of the event. Falls back to the most-recent entry if no match.
		const messages = (event.messages ?? []) as Array<{ role: string; content: string | unknown[] }>;
		let lastUserPrompt = "";
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]?.role === "user") {
				const content = messages[i]?.content;
				lastUserPrompt = typeof content === "string" ? content : JSON.stringify(content);
				break;
			}
		}
		// Find the pending search by matching against the last user message
		// of the event. If no key matches AND the map has exactly one
		// entry, fall back to that entry (handles prompt-mutation edge
		// case). Otherwise no pending search.
		let pending: Promise<FormattedMemory | null> | null = pendingMemorySearches.get(lastUserPrompt) ?? null;
		if (!pending && pendingMemorySearches.size === 1) {
			pending = Array.from(pendingMemorySearches.values())[0] ?? null;
		}
		const result = await injectMemoryContext(event, pending);
		if (pending) pendingMemorySearches.delete(lastUserPrompt);
		return result;
	});

	// memory_get tool — the ONLY programmatic strength-feedback entry.
	//
	// Search (`recallAtoms`) is deliberately bump-free: surfacing a candidate
	// in context is not the same as the LLM acting on it. Only an explicit
	// `memory_get(id)` call from the agent counts as a feedback signal, and
	// it must increment `access_count` / stamp `last_access` so the
	// strength-feedback loop can keep the atom visible. The bump is the
	// path from "search hit" to "this is worth surfacing again" — without
	// it, every search would converge to the same ranking and the memory
	// system would stop learning from agent behaviour.
	//
	// Tool contract (see specs/memory-search-decoupled/spec.md):
	//   - parameters: { id: string (UUID) }
	//   - success: { content: [{ type: "text", text: "<title>\n<summary>\n<content>" }],
	//                details: { id, type, title, content, summary, tags, importance } }
	//   - not found: { content: [{ type: "text", text: "atom not found: <id>" }],
	//                  details: { error: "not_found", id } }
	//   - updateAccess is called ONLY on the success branch; missing ids
	//     never modify any row.
	pi.registerTool({
		name: "memory_get",
		label: "Memory Get",
		description:
			"Fetch the full content of an atom by id. Use this to hydrate a search result before acting on it. Bumps the atom's access_count so the strength-feedback loop keeps it visible.",
		promptSnippet: "Fetch full content of a memory atom.",
		parameters: MemoryGetParams,
		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			_ctx,
		): Promise<AgentToolResult<MemoryGetDetails>> {
			const index = new MemoryIndex(DEFAULT_DB_PATH);
			await index.init();
			try {
				const atom = index.getAtom(params.id);
				if (atom === null) {
					return {
						content: [
							{ type: "text", text: `atom not found: ${params.id}` },
						],
						details: { error: "not_found", id: params.id },
					};
				}
				// Strength-feedback bump — the sole programmatic entry.
				// Must run after the null-check so missing ids never write.
				index.updateAccess(atom.id);
				return {
					content: [
						{
							type: "text",
							text: `${atom.title}\n${atom.summary}\n${atom.content}`,
						},
					],
					details: {
						id: atom.id,
						type: atom.type,
						title: atom.title,
						content: atom.content,
						summary: atom.summary,
						tags: atom.tags,
						importance: atom.importance,
					},
				};
			} finally {
				index.close();
			}
		},
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