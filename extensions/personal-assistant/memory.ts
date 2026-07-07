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
//   - format.ts     — formatMemoryContext (renders summaries + file: lines
//                     for the LLM's read tool to follow up on search results)
//
// What memory.ts still owns:
//   - registerMemory(pi) — wires session_before_compact + session_start + the
//     before_agent_start / context memory-injection pipeline + a tool_result
//     hook on the read tool. The hook is the ONLY programmatic entry point
//     that records strength feedback for a specific atom (bump `access_count`
//     / `last_access` via `index.updateAccess`). Search does NOT bump — see
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
//     an 8s timeout) and injects the formatted block (summary + relative path
//     per atom) into the last user message. The LLM calls the read tool on
//     the formatted file path to fetch the full body — that read fires the
//     tool_result hook in registerMemory which records the strength feedback.
//     Non-destructive: original event is returned if nothing to inject.
//   - The read-tool hook in registerMemory is the only entry that bumps
//     strength. Missing atom paths (read of a non-atom file or a path that
//     doesn't match `${atomsDir}/<type>/<uuid>.md`) are ignored. Failed DB
//     writes are best-effort and never surface to the user.
//   - loadConfig returns {} on any failure — never throws. Real config wiring
//     is external (see SettingsManager / webui routes).

import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, completeSimple } from "@earendil-works/pi-ai/compat";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { runDecay } from "./decay.ts";
import { MemoryIndex } from "./storage.ts";
import { recallAtoms } from "./search.ts";
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
 *
 * `memory.gate` and `memory.rerank` (both default `enabled = true`, when
 * the sub-object is omitted or when `enabled` is omitted inside it) gate
 * the context-hook recall pipeline (spec R5 / design.md D6). Both are
 * OPTIONAL so an older settings.json without these fields keeps loading —
 * `loadConfig()` already coalesces missing keys via `JSON.parse + ?? {}`.
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
		embedding?: { ollamaUrl?: string; model?: string; provider?: string };
		decay?: { baseDecay?: number; archiveThreshold?: number };
		injection?: { maxCount?: number };
		autoDecay?: boolean;
		autoExtract?: boolean;
		/** Context-hook gate (LLM decides need-memory + rewrites query).
		 *  Default enabled when omitted; absence means "use default". */
		gate?: { enabled?: boolean };
		/** Context-hook query-rewrite stage (refines user query for search).
		 *  Default enabled when omitted; absence means "use default".
		 *  Independent from gate.enabled — any combination is valid (B8). */
		rewrite?: { enabled?: boolean };
		/** Context-hook cross-encoder rerank stage.
		 *  Default enabled when omitted; absence means "use default". */
		rerank?: { enabled?: boolean };
		/**
		 * tag alias mapping for `normalizeTags` (extensions/personal-assistant/tag-alias.ts).
		 * Applied dual-side:写入侧折叠 atom.tags,查询侧折叠 query tokens。
		 * 缺失/非对象时 graceful degradation(仅 Set 去重)。
		 * 通过 PATCH /api/settings 修改,运行时立即生效。
		 */
		tagAliases?: Record<string, string>;
		/**
		 * score 公式中 `tag_overlap` 项的权重。默认 0.10。
		 * 主项 `cosine × (1 + 0.3strength + 0.2importance)` 不受此配置影响。
		 */
		tagOverlapWeight?: number;
		/**
		 * score 公式中 `freshness_decay` 项的权重。默认 0.05。
		 * freshness = exp(-daysSinceUpdate / 30),固定 30 天半衰期。
		 */
		freshnessWeight?: number;
	};
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default sqlite database path. Override via config.memory.dbPath. */
export const DEFAULT_DB_PATH = join(homedir(), ".pi", "agent", "memory", "memory.db");

/** Default atom file directory. Override via config.memory.atomsDir. */
export const DEFAULT_ATOMS_DIR = join(homedir(), ".pi", "agent", "memory", "atoms");

/**
 * TUI notify that swallows errors. Some ctx shapes (rpc/print backends)
 * have no `notify` at all, or it can throw if the user has dismissed the
 * TUI. Treat every notify as best-effort — never let a UI hiccup affect
 * the compact pipeline.
 */
function notifySafely(
	ctx: { ui?: { notify?: (msg: string, type?: "info" | "warning" | "error") => void } },
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	try {
		ctx.ui?.notify?.(message, type);
	} catch {
		// best-effort, see comment above
	}
}

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
 * Drift-sweep interval. The tool_result hook catches write/edit drift
 * immediately, but the agent can still drift .md files via bash (sed,
 * vi, redirect) or by hand-editing outside pi. The periodic sweep
 * closes that gap by walking atomsDir, comparing each .md's body
 * fingerprint to the DB's content_fingerprint, and reindexing drifted
 * atoms via bge-m3.
 */
const DRIFT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastDriftSweepAt = 0;

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
// Tool-result hook — strength-feedback via read-tool interception
// ---------------------------------------------------------------------------

/**
 * Pattern that matches a read-tool input whose path lives under the
 * configured atoms directory. Three capture groups:
 *   1. atomsDir (the absolute base, e.g. /home/qjh/.pi/agent/memory/atoms)
 *   2. atom type (rule | fact | process)
 *   3. atom id (UUID)
 *
 * The atomsDir prefix is captured as a literal so the regex compiles
 * against the actual configured path (which can be overridden via
 * `config.memory.atomsDir`). Any path that doesn't match this pattern
 * is left alone — the hook only fires for read calls that targeted an
 * atom file.
 */
function makeAtomPathRegex(atomsDir: string): RegExp {
	// Escape regex metachars in the directory path (the user's home
	// directory can in principle contain characters like `.` that are
	// regex-significant).
	const escaped = atomsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped}/(rule|fact|process)/([0-9a-f-]{36})\\.md$`);
}

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
			notifySafely(
				ctx,
				`memory: extraction failed, compact cancelled — ${msg}`,
				"error",
			);
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

		// 3. Source messages — real fields on SessionBeforeCompactEvent.
		// BOTH messagesToSummarize (history being summarised) and
		// turnPrefixMessages (the split-turn prefix, the older messages
		// of the current turn when compaction cut inside an in-progress
		// turn) are fed to extraction. Compaction is split-turn whenever
		// /compact or auto-compact fires mid-turn — the only messages
		// worth extracting live in turnPrefixMessages in that case, and
		// skipping them silently drops the only conversation content of
		// the session. Reading only messagesToSummarize is the bug that
		// made split-turn compactions produce no atoms.
		const prep = (event as {
			preparation?: { messagesToSummarize?: unknown[]; turnPrefixMessages?: unknown[] };
		}).preparation ?? {};
		const rawMessages = [
			...(Array.isArray(prep.messagesToSummarize) ? prep.messagesToSummarize : []),
			...(Array.isArray(prep.turnPrefixMessages) ? prep.turnPrefixMessages : []),
		];
		if (rawMessages.length === 0) {
			notifySafely(ctx, "memory: compact has no messages to extract — skipping", "info");
			return;
		}

		// Convert AgentMessage → the simple {role, content: string} shape
		// that extractMemoriesWithCallLlm expects. User messages may be
		// string or (TextContent|ImageContent)[]; assistant messages are
		// arrays of TextContent/ThinkingContent/ToolCall. We flatten to text
		// only — images and tool calls don't help the extraction LLM.
		const messages = (rawMessages as unknown[])
			.map((m) => agentMessageToExtractionMessage(m as AgentMessage))
			.filter((m): m is { role: string; content: string } => m !== null);
		if (messages.length === 0) {
			notifySafely(
				ctx,
				`memory: ${rawMessages.length} messages but none have extractable text — skipping`,
				"info",
			);
			return;
		}

		// Loud start notification — the user has been bitten by silent
		// compact-without-extract before, so tell them the moment we
		// start. Including message count + extraction model name so the
		// fix-it-up path (settings.json / models.json) is obvious if it
		// fails.
		notifySafely(
			ctx,
			`memory: extracting from ${messages.length} messages (model: ${extractionCfg.provider}/${extractionCfg.model})...`,
			"info",
		);

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

		// maxTokens budget for the extraction response. Same pattern pi core
		// uses for /compact (harness/compaction/compaction.ts: `min(0.8 *
		// reserveTokens, model.maxTokens)`): scale with the model's own
		// maxTokens so reasoning models (deepseek-v4-flash 8k, minimax M3
		// 131k) get budget proportional to their capability, while a hard
		// 8192 ceiling stops the worst-case model from being asked to write
		// 100k tokens of JSON. The previous hardcoded 2048 was a v1
		// leftover that truncated reasoning models mid-think.
		//
		// 8192 covers a generous extraction (40+ atoms with full content +
		// tags) and stays well under any model's maxTokens.
		const extractionMaxTokens = Math.min(
			model.maxTokens > 0 ? Math.floor(0.8 * model.maxTokens) : 4096,
			8192,
		);

		const callLlm = async (prompt: string): Promise<string> => {
			const response = await completeSimple(
				model,
				{ messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
				{ apiKey: auth.apiKey, headers, maxTokens: extractionMaxTokens },
			);
			if (!response.content) {
				throw new Error("No content in LLM response");
			}
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			for (const c of response.content) {
				if (c.type === "text" && "text" in c) {
					textParts.push(c.text);
				} else if (c.type === "thinking" && "thinking" in c) {
					// Fallback: some reasoning models (deepseek-v4-flash
					// when finish_reason=length truncates the answer) put
					// the full response in the thinking block and leave
					// content empty. Treat that as a last-resort source so
					// the extraction can still get a parseable JSON.
					thinkingParts.push(c.thinking);
				}
			}
			if (textParts.length > 0) {
				return textParts.join("");
			}
			if (thinkingParts.length > 0) {
				// Some reasoning-only responses include a final answer
				// after the closing </think> tag. Strip any leading
				// <think>...</think> block so parseExtractionJson sees a
				// raw JSON string instead of a thinking-prefixed one.
				const raw = thinkingParts.join("");
				const stripped = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
				if (stripped.length > 0) return stripped;
				throw new Error(
					"No text content in LLM response (response was a thinking block only; model may have run out of tokens before writing the answer)",
				);
			}
			throw new Error("No text content in LLM response");
		};

		// 5. Run extraction. MemoryIndex self-heals its parent dir
		// (storage.ts) so a fresh ~/.pi/agent/memory/ works.
		const index = new MemoryIndex(dbPath);
		await index.init();
		try {
			const result = await extractMemoriesWithCallLlm(callLlm, messages, index, {
				atomsDir,
				// `model` here is the audit label written to
				// extraction-report.json as `modelUsed` — it must name the
				// chat completion model that actually produced the
				// extraction, not the embedding model (bge-m3) we use for
				// vector recall. Mislabeling made a /compact look like it
				// ran on the wrong model in the log.
				model: `${extractionCfg.provider}/${extractionCfg.model}`,
			});
			await writeExtractionReport(result.plan);
			// Completion notify — user can immediately see whether the
			// extraction produced atoms or was a no-op (LLM returned 0
			// items, or all items were duplicates of existing atoms).
			// "skipping" counts cover the duplicate-suppression path.
			const created = result.created.length;
			const superseded = result.superseded.length;
			const skipped = result.skipped.length;
			const total = created + superseded + skipped;
			notifySafely(
				ctx,
				total === 0
					? "memory: extraction complete — 0 atoms (nothing new to remember)"
					: `memory: extraction complete — ${created} new, ${superseded} updated, ${skipped} unchanged (of ${result.plan.items.length} proposed)`,
				"info",
			);
		} finally {
			index.close();
		}
	}

	/**
	 * Normalize decay config from settings.json, accepting both
	 * camelCase (baseDecay, archiveThreshold) and snake_case
	 * (base_decay, archive_threshold) key names.
	 */
	function normalizeDecayConfig(raw: Record<string, unknown> | undefined): {
		baseDecay?: number;
		archiveThreshold?: number;
	} {
		if (!raw) return {};
		return {
			baseDecay: (raw.baseDecay as number | undefined) ?? (raw.base_decay as number | undefined),
			archiveThreshold:
				(raw.archiveThreshold as number | undefined) ?? (raw.archive_threshold as number | undefined),
		};
	}

	// session_start — throttled decay run + missing-vector backfill.
	// The first session in a process always runs maintenance; subsequent
	// session_start events within the DECAY_INTERVAL_MS window skip.
	// Errors are swallowed so a broken path does not block startup.
	pi.on("session_start", async (_event, _ctx) => {
		const now = Date.now();
		if (now - lastDecayAt < DECAY_INTERVAL_MS) return;
		lastDecayAt = now;

		const config = loadConfig();
		const dbPath = config.memory?.dbPath ?? DEFAULT_DB_PATH;

		const index = new MemoryIndex(dbPath);
		await index.init();
		try {
			// 1. Decay (strength → archive)
			await runDecay(index, normalizeDecayConfig(config.memory?.decay as Record<string, unknown> | undefined));

			// 2. Missing-vector backfill: atoms that existed before the
			//    vector schema was added have no memory_vectors row and
			//    are invisible to the dense channel. Generate embeddings
			//    and insert them. One-shot per atom — once inserted, no
			//    future overhead.
			const missingIds = index.listMissingVectorIds();
			if (missingIds.length > 0) {
				const { embedText, buildEmbeddableText } = await import("./embed.ts");
				for (const id of missingIds) {
					try {
						const atom = index.getAtom(id);
						if (!atom) continue;
						const text = buildEmbeddableText(atom);
						const embedding = await embedText(text);
						if (embedding) {
							index.upsertVector(id, embedding);
						}
					} catch {
						// Swallow per-atom failures so one broken atom
						// does not block the rest.
					}
				}
			}

			// 3. Embeddable-text version migration: atoms whose stored
			//    `embed_text_version` is below the current version have
			//    embeddings generated from an older `buildEmbeddableText`
			//    (e.g. v1 included `content`, v2 dropped it). Re-embed
			//    them with the current text set so the dense channel
			//    direction reflects the current design. Incremental —
			//    only stale atoms are returned, so once the migration
			//    completes subsequent session_starts no-op on this step.
			const { CURRENT_EMBEDDABLE_TEXT_VERSION } = await import("./embed.ts");
			const staleIds = index.listStaleEmbedVersionIds(
				CURRENT_EMBEDDABLE_TEXT_VERSION,
			);
			if (staleIds.length > 0) {
				const { embedText, buildEmbeddableText } = await import("./embed.ts");
				let migrated = 0;
				for (const id of staleIds) {
					try {
						const atom = index.getAtom(id);
						if (!atom) continue;
						const text = buildEmbeddableText(atom);
						const embedding = await embedText(text);
						if (embedding) {
							index.upsertVector(id, embedding);
							index.setEmbedTextVersion(
								id,
								CURRENT_EMBEDDABLE_TEXT_VERSION,
							);
							migrated++;
						}
					} catch {
						// Swallow per-atom failures so one broken atom
						// does not block the rest. The atom stays at its
						// stale version and is retried on the next session.
					}
				}
				if (migrated > 0) {
					console.log(
						`[memory] re-embedded ${migrated} atom(s) for embed_text_version=${CURRENT_EMBEDDABLE_TEXT_VERSION}`,
					);
				}
			}

			// 4. Drift sweep: walk atomsDir, find .md files whose body
			//    no longer matches the DB's content_fingerprint, and
			//    reindex them via bge-m3. Catches bash / manual / out-of-
			//    pipeline edits that the tool_result hook can't see.
			//    Throttled to once per DRIFT_SWEEP_INTERVAL_MS.
			if (now - lastDriftSweepAt >= DRIFT_SWEEP_INTERVAL_MS) {
				lastDriftSweepAt = now;
				try {
					const { runDriftSweep } = await import("./drift-sweep.ts");
					const atomsDir = config.memory?.atomsDir ?? DEFAULT_ATOMS_DIR;
					const stats = await runDriftSweep(atomsDir, index);
					if (stats.drifted > 0) {
						console.log(
							`[memory] drift sweep: checked=${stats.checked} drifted=${stats.drifted} reindexed=${stats.reindexed} failed=${stats.failed}`,
						);
					}
				} catch (err) {
					// Sweep is best-effort — a bge-m3 outage is logged but
					// does not block session_start.
					console.warn(`[memory] drift sweep failed: ${(err as Error).message}`);
				}
			}
		} finally {
			index.close();
		}
	});

	// before_agent_start — Task 5.1 cleanup-only.
	//
	// Recall pipeline (search.ts / format.ts / gate / rerank / TUI status)
	// moved to the context hook in Task 5.2: gate logic needs `messages[]`,
	// which only the context hook exposes. This hook now exists ONLY to
	// clear the module-level `pendingMemorySearches` Map — a defense-in-
	// depth reset that prevents stale in-flight promises from leaking
	// across sessions. `registerMemory` (line above) already resets the
	// map at registration time; this hook is the per-turn belt-and-
	// suspenders.
	//
	// The hook registration itself is preserved so the extension loader
	// does not emit "unhandled before_agent_start" warnings — principle
	// 8 (no backward-compat breakage) outweighs the temptation to remove
	// the .on() call.
	pi.on("before_agent_start", async (_event, _ctx) => {
		pendingMemorySearches = new Map();
	});

	// context — gate→recall→rerank→format→inject pipeline (task 5.2).
	//
	// This handler replaces the old pendingMemorySearches async-fire pattern
	// with a synchronous pipeline that runs within the hook's own body:
	//
	//   1. Extract current + recent user messages from event.messages[]
	//   2. Load config and check gate.enabled (dynamic import ./gate.ts)
	//   3. callGate(current, recent, {timeoutMs: 500})
	//   4. If gate skips (null / need_memory=false) → setStatus + return
	//   5. Open MemoryIndex (for recallAtoms hydration)
	//   6. recallAtoms(index, search_query, {topK:20})
	//   7. If rerank.enabled (dynamic import ./rerank.ts) → rerankAndFilter
	//         Array.isArray branch: filtered results
	//         RerankFallback branch: topK fallback + setStatus
	//   8. Assign relativePath on each result
	//   9. setStatus with pipeline outcome
	//  10. If empty results → return event unchanged
	//  11. formatMemoryContext(results, 4000) (dynamic import ./format.ts)
	//  12. Inject formatted prefix into last user message
	//  13. Return { messages: newMessages }
	//
	// Non-destructive: the original event reference is returned unchanged
	// when no memory should be injected. Modifications produce a fresh
	// messages array — never the caller's array reference.
	//
	// Dynamic imports for gate/rerank/format keep their modules off the
	// cold-start path (design.md D6). Top-level imports for MemoryIndex /
	// recallAtoms / loadConfig are unaffected.
	pi.on("context", async (event: ContextEvent, ctx) => {
		const messages = (event.messages ?? []) as Array<{ role: string; content: string | unknown[] }>;
		if (messages.length === 0) return event as unknown as { messages?: AgentMessage[] };

		// Skip non-user continuations (tool results, assistant mid-turn).
		if (messages[messages.length - 1]?.role !== "user") {
			return event as unknown as { messages?: AgentMessage[] };
		}

		// 1. Extract current (last) and recent (up to 3 prior) user messages
		const userMessages: string[] = [];
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]?.role === "user") {
				const content = messages[i]?.content;
				userMessages.unshift(
					typeof content === "string" ? content : JSON.stringify(content),
				);
				if (userMessages.length >= 4) break;
			}
		}

		const current = userMessages[userMessages.length - 1]!;
		const recent = userMessages.slice(0, -1);

		// 2. Load config + gate check
		const config = loadConfig();

		// 3. Gate decision (dynamic import)
		const gateEnabled = config.memory?.gate?.enabled ?? true;
		let subqueries: string[] = [current];
		let gateStatus = "disabled";
		let gateMs = 0;
		let gateT0 = 0;
		let hybridCount = 0;
		let finalCount = 0;
		let recallMs = 0;
		let rerankStatus = "skip";
		let rerankReason: string | undefined;
		let rerankMs = 0;
		let rewriteStatus = "skip";
		let rewriteMs = 0;
		const rewriteEnabled = config.memory?.rewrite?.enabled ?? true;
		const gateLogLabels: Record<string, string> = {
			parse: "parse-fail",
			unreachable: "down",
		};
		const emitRecallDebug = (line: string) => {
			if (ctx.ui?.setStatus) {
				ctx.ui.setStatus("memory-debug", line);
			} else {
				console.debug(line);
			}
		};
		const emitGateSkipDebug = () => {
			const reasonStr = rerankReason ? `(${rerankReason})` : "";
			const gateLabel = gateLogLabels[gateStatus] ?? gateStatus;
			emitRecallDebug(
				`[recall] gate=${gateLabel} rewrite=skip rerank=${rerankStatus}${reasonStr} pre=0 post=0 latency {gate:${gateMs.toFixed(0)}ms rewrite:0ms recall:0ms rerank:0ms}`,
			);
		};
		if (gateEnabled) {
			gateT0 = performance.now();
			const { callGate } = await import("./gate.ts");
			const gateDecision = await callGate(current, recent, { timeoutMs: 5000 });
			gateMs = performance.now() - gateT0;

			if (gateDecision === null) {
				gateStatus = "unknown";
				ctx.ui?.setStatus?.("memory", "⚠ gate unknown, skipped");
				emitGateSkipDebug();
				return event as unknown as { messages?: AgentMessage[] };
			}
			if (typeof gateDecision === "string") {
				gateStatus = gateDecision;
				if (gateDecision === "timeout") {
					ctx.ui?.setStatus?.("memory", "⚠ gate timeout, skipped");
				} else if (gateDecision === "parse") {
					ctx.ui?.setStatus?.("memory", "🚫 gate skipped (parse failed)");
				} else if (gateDecision === "unreachable") {
					ctx.ui?.setStatus?.("memory", "⚠ gate down, skipped");
				}
				emitGateSkipDebug();
				return event as unknown as { messages?: AgentMessage[] };
			}
			if (!gateDecision.need_memory) {
				gateStatus = "skip-false";
				ctx.ui?.setStatus?.("memory", "🚫 gate skipped");
				emitGateSkipDebug();
				return event as unknown as { messages?: AgentMessage[] };
			}
			gateStatus = "pass";

			// 3a. Rewrite (dynamic import) — gate pass only
			if (rewriteEnabled) {
				const rewriteT0 = performance.now();
				const { rewriteQueries } = await import("./rewrite.ts");
				const outcome = await rewriteQueries(current, recent, { timeoutMs: 5000 });
				rewriteMs = performance.now() - rewriteT0;
				if (Array.isArray(outcome)) {
					subqueries = outcome;
					rewriteStatus = "ok";
				} else {
					subqueries = outcome.subqueries;
					rewriteStatus = outcome.reason;
				}
			} else {
				rewriteStatus = "disabled";
			}
		} else {
			gateStatus = "disabled";

			// Rewrite — also runs when gate is disabled (B7 independent of gate)
			if (rewriteEnabled) {
				const rewriteT0 = performance.now();
				const { rewriteQueries } = await import("./rewrite.ts");
				const outcome = await rewriteQueries(current, recent, { timeoutMs: 5000 });
				rewriteMs = performance.now() - rewriteT0;
				if (Array.isArray(outcome)) {
					subqueries = outcome;
					rewriteStatus = "ok";
				} else {
					subqueries = outcome.subqueries;
					rewriteStatus = outcome.reason;
				}
			} // else: leave rewriteStatus as "skip"
		}

		// 4. Open MemoryIndex and per-subquery recall + rerank
		const dbPath = config.memory?.dbPath ?? DEFAULT_DB_PATH;
		const index = new MemoryIndex(dbPath);
		await index.init();
		try {
			const retrievalT0 = performance.now();
			const rerankEnabled = config.memory?.rerank?.enabled ?? true;
			let poolResults: RecallResult[][];
			let rawTotal = 0;
			let rerankFallback = false;
			if (rerankEnabled) {
				let recMs = 0;
				let rerMs = 0;
				const { rerankAndFilter } = await import("./rerank.ts");
				const poolWithStatus = await Promise.all(
					subqueries.map(async (sq) => {
						const r0 = performance.now();
						const sqResults = await recallAtoms(index, sq, { topK: 20 });
						rawTotal += sqResults.length;
						recMs += performance.now() - r0;
						if (sqResults.length === 0) return { results: [] as RecallResult[], fallback: false };
						const r1 = performance.now();
						const scored = await rerankAndFilter(sq, sqResults);
						rerMs += performance.now() - r1;
						if (Array.isArray(scored)) return { results: scored, fallback: false };
						rerankFallback = true;
						rerankReason = scored.reason;
						return { results: scored.topK, fallback: true };
					}),
				);
				recallMs = recMs;
				rerankMs = rerMs;
				poolResults = poolWithStatus.map((p) => p.results);
			} else {
				poolResults = await Promise.all(
					subqueries.map((q) => recallAtoms(index, q, { topK: 20 })),
				);
			}
			// Merge per-subquery pools: dedup by atom.id, sort by rerankScore DESC.
			const { mergeByRerankScore } = await import("./merge.ts");
			const results = mergeByRerankScore(poolResults);
			hybridCount = rawTotal;
			rerankStatus = rerankFallback
				? "fallback"
				: results.length > 0
					? "ok"
					: "all-below";

			// 5. Assign relativePath and prepare for inject
			const finalResults = results;

			// 6. Assign relativePath
			for (const r of finalResults) {
				r.relativePath = `${r.atom.type}/${r.atom.id}.md`;
			}
			finalCount = finalResults.length;

			// 7. setStatus with pipeline outcome
			if (rerankFallback) {
				ctx.ui?.setStatus?.("memory", "⚠ rerank fallback");
			} else if (finalResults.length === 0) {
				ctx.ui?.setStatus?.("memory", "🔍 no memory match");
			} else {
				const rules = finalResults.filter((r) => r.atom.type === "rule").length;
				const facts = finalResults.filter((r) => r.atom.type === "fact").length;
				const processes = finalResults.filter((r) => r.atom.type === "process").length;
				const maxRerankScore = Math.max(...finalResults.map((r) => r.rerankScore ?? 0));
				ctx.ui?.setStatus?.(
					"memory",
					`📦 ${finalResults.length} atoms · rule=${rules} fact=${facts} process=${processes} · top=${maxRerankScore}`,
				);
			}

			// 7b. Debug log — single per-call emission (task 5.4)
			const gateLabel = gateLogLabels[gateStatus] ?? gateStatus;
			const reasonStr = rerankReason ? `(${rerankReason})` : "";
			const rewriteDisplay = rewriteStatus === "ok" ? `ok(${subqueries.length})` : rewriteStatus;
			emitRecallDebug(
				`[recall] gate=${gateLabel} rewrite=${rewriteDisplay} rerank=${rerankStatus}${reasonStr} pre=${hybridCount} post=${finalCount} latency {gate:${gateMs.toFixed(0)}ms rewrite:${rewriteMs.toFixed(0)}ms recall:${recallMs.toFixed(0)}ms rerank:${rerankMs.toFixed(0)}ms}`,
			);

			if (finalResults.length === 0) {
				return event as unknown as { messages?: AgentMessage[] };
			}

			// 8. Format (dynamic import)
			const { formatMemoryContext } = await import("./format.ts");
			const formatted = formatMemoryContext(finalResults, 4000);

			// 9. Inject into last user message
			let lastUserIdx = -1;
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i]?.role === "user") {
					lastUserIdx = i;
					break;
				}
			}
			if (lastUserIdx === -1) return event as unknown as { messages?: AgentMessage[] };

			const lastUser = messages[lastUserIdx]!;
			const originalContent =
				typeof lastUser.content === "string"
					? lastUser.content
					: JSON.stringify(lastUser.content);
			const atomsDir = config.memory?.atomsDir ?? DEFAULT_ATOMS_DIR;
			const memoryPrefix = `[Relevant memory context — atoms at ${atomsDir}]\n${formatted.text}\n\n[User message]\n`;
			const newContent = memoryPrefix + originalContent;

			const newMessages = [...messages];
			newMessages[lastUserIdx] = { ...lastUser, content: newContent };
			return { messages: newMessages as unknown as AgentMessage[] };
		} finally {
			index.close();
		}
	});

	// tool_result hook — strength feedback + vector sync via tool interception.
	//
	// The hook fires on every tool_result. The behaviour depends on the
	// tool that produced the result:
	//
	//   read   — strength feedback. Bump `access_count` / `last_access`
	//            for the matched atom so the strength-decay loop keeps it
	//            visible. Search (`recallAtoms`) is deliberately bump-free:
	//            surfacing a candidate in context is not the same as the
	//            LLM acting on it, and the strength signal only reflects
	//            actual reads.
	//
	//   write / edit — vector sync. When the agent mutates an atom .md
	//            file directly (bypassing the extraction pipeline), the
	//            on-disk content drifts from the cached vector and the
	//            fingerprint stored in the DB. We call reindexOne so the
	//            bge-m3 service recomputes dense + sparse vectors for the
	//            new content. Without this, future recalls would rank
	//            against stale embeddings.
	//
	// Both branches share the same atom-path detection
	// (`${atomsDir}/<type>/<uuid>.md`, with `~/` → home-dir expansion).
	// Both are best-effort: a failed DB write or reindex call never
	// surfaces to the user and never interrupts the agent loop.
	//
	// The atomsDir regex is rebuilt each hook call so it always tracks
	// the live `config.memory.atomsDir` override (in case the user
	// reloaded with a different path).
	pi.on("tool_result", (event) => {
		if (event.isError) return;

		// Resolve the path that was touched. read/write/edit all carry
		// `path` in input; bash commands are intentionally ignored (the
		// agent can still drift the file via bash, but drift detection
		// for that path is a separate concern — typically a periodic
		// sweep over content_fingerprint, out of scope here).
		const rawPath = event.input.path;
		if (typeof rawPath !== "string") return;

		// Expand a leading `~/` to the home directory so the atomsDir
		// regex (which is anchored to the absolute home) matches paths
		// the LLM happens to write in shell-friendly form.
		const path = rawPath.startsWith("~/") || rawPath === "~"
			? join(homedir(), rawPath.slice(1))
			: rawPath;

		const config = loadConfig();
		const atomsDir = config.memory?.atomsDir ?? DEFAULT_ATOMS_DIR;
		const match = makeAtomPathRegex(atomsDir).exec(path);
		if (!match) return;

		const atomId = match[2]!;

		if (event.toolName === "read") {
			// Strength-feedback bump. Sync, but non-blocking: the
			// best-effort index.updateAccess returns immediately and we
			// never throw on a missed write.
			const index = new MemoryIndex(DEFAULT_DB_PATH);
			index.init()
				.then(() => {
					try {
						index.updateAccess(atomId);
					} finally {
						index.close();
					}
				})
				.catch(() => {});
		} else if (event.toolName === "write" || event.toolName === "edit") {
			// Vector sync. We do NOT update the DB content row here —
			// the only writer that produces a MemoryAtom row is the
			// extraction pipeline. The on-disk .md file is the
			// canonical source of text; the bge-m3 service reads it
			// during reindex and produces a fresh vector. The DB
			// content_fingerprint will be stale until the next
			// extraction run, but the vector matches the .md on disk,
			// which is what recall actually uses.
			//
			// Lazy-import reindexOne to keep the bge-m3 client out of
			// the cold-start import graph (mirrors the gate/rewrite
			// dynamic-import pattern in this file).
			import("./bge-reindex.ts")
				.then(({ reindexOne }) => reindexOne(atomId))
				.then((res) => {
					if (!res.ok) {
						console.warn(
							`[memory] reindex after ${event.toolName} ${path} failed: ${res.error ?? "unknown"}`,
						);
					}
				})
				.catch(() => {
					// Best-effort: a missing bge-m3 service or network
					// hiccup must never surface to the user.
				});
		}
	});

	// Periodic drift sweep. The session_start hook above also runs the
	// sweep (throttled to once per DRIFT_SWEEP_INTERVAL_MS), but in a
	// long-running process the user may never trigger session_start
	// again, so a wall-clock timer keeps drift from accumulating over
	// days. The timer is unref'd so it never holds the process open
	// past the agent loop's natural exit.
	const driftTimer = setInterval(() => {
		void (async () => {
			const config = loadConfig();
			const dbPath = config.memory?.dbPath ?? DEFAULT_DB_PATH;
			const atomsDir = config.memory?.atomsDir ?? DEFAULT_ATOMS_DIR;
			const index = new MemoryIndex(dbPath);
			try {
				await index.init();
				const { runDriftSweep } = await import("./drift-sweep.ts");
				const stats = await runDriftSweep(atomsDir, index);
				if (stats.drifted > 0) {
					console.log(
						`[memory] periodic drift sweep: checked=${stats.checked} drifted=${stats.drifted} reindexed=${stats.reindexed} failed=${stats.failed}`,
					);
				}
			} catch (err) {
				console.warn(`[memory] periodic drift sweep failed: ${(err as Error).message}`);
			} finally {
				index.close();
			}
		})();
	}, DRIFT_SWEEP_INTERVAL_MS);
	// unref: don't keep the process alive just for the drift sweep.
	// The session_start hook handles the case where the process is
	// already short-lived; this timer is for long-running processes.
	if (typeof driftTimer.unref === "function") driftTimer.unref();
}

