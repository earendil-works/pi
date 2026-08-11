/**
 * Ghost responder: answer the current session's clarifying questions *as the previous
 * session*, from that session's saved transcript.
 *
 * The handoff note the reader ingested carries `session_file` — the predecessor's full
 * JSONL transcript. That session is gone, but everything it knew is in the file, so a
 * one-shot LLM call over transcript + question resurrects it well enough to answer
 * "why did you rule that approach out?" long after it quit. No coordination, no
 * timing: this works whether the predecessor died seconds or days ago. (When both
 * sessions are alive at once, the sibling `intercom` extension is the live channel.)
 *
 * Like `compose.ts`, every pi import is type-only, which keeps this module
 * unit-testable without pulling pi's runtime module graph into the test process. The
 * JSONL parse is deliberately reimplemented here (12 lines, same skip-malformed-lines
 * semantics as pi's `parseSessionEntries`) rather than imported for the same reason.
 */

import type { Message, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type HandoffNote, listArchivedNotePaths, listPendingNotePaths, readNote } from "./notes.ts";

/**
 * Transcript cap, characters, keeping the tail. Bounded so one giant pasted log in the
 * predecessor's history cannot blow the question call past the model's context; the
 * tail is kept because the end of a session is where the answers to "where did you
 * leave off and why" live.
 */
const TRANSCRIPT_CHARS = 150_000;
const TRUNCATION_MARKER = "(transcript truncated: the earliest part of the session is omitted)";

export interface Predecessor {
	path: string;
	note: HandoffNote;
}

function newestWithTranscript(paths: string[], accept: (note: HandoffNote) => boolean): Predecessor | undefined {
	// Filenames are timestamp-prefixed and the lists are sorted, so scan newest-first.
	for (let i = paths.length - 1; i >= 0; i--) {
		const note = readNote(paths[i]);
		if (note?.frontmatter.session_file && accept(note)) return { path: paths[i], note };
	}
	return undefined;
}

/**
 * The session to impersonate, in order of preference:
 *
 * 1. The note *this* session ingested (archived, stamped `consumed_by` = us). The
 *    briefing the user is asking follow-ups about.
 * 2. The newest pending note — a predecessor whose briefing nobody has consumed yet.
 * 3. The newest archived note of any provenance — better a slightly stale predecessor
 *    than refusing to answer at all.
 *
 * Determined by scanning disk rather than by reader state, so it survives `/reload`
 * (which resets extension state) and works even in a session that never ingested a
 * note. Notes without `session_file` (`--no-session` writers) can never answer and
 * are skipped at every step.
 */
export function findPredecessor(cwd: string, sessionId: string): Predecessor | undefined {
	const archived = listArchivedNotePaths(cwd);
	return (
		newestWithTranscript(archived, (note) => note.frontmatter.consumed_by === sessionId) ??
		newestWithTranscript(listPendingNotePaths(cwd), () => true) ??
		newestWithTranscript(archived, () => true)
	);
}

interface TextBlock {
	type: "text";
	text: string;
}

interface ToolCallBlock {
	type: "toolCall";
	name: string;
	arguments?: Record<string, unknown>;
}

function isTextBlock(block: unknown): block is TextBlock {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: unknown }).type === "text" &&
		typeof (block as { text?: unknown }).text === "string"
	);
}

function isToolCallBlock(block: unknown): block is ToolCallBlock {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: unknown }).type === "toolCall" &&
		typeof (block as { name?: unknown }).name === "string"
	);
}

/** Text plus one-line markers for tool calls, so the narrative keeps what the session *did*. */
function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (isTextBlock(block)) {
			const text = block.text.trim();
			if (text) parts.push(text);
		} else if (isToolCallBlock(block)) {
			const path = block.arguments?.path ?? block.arguments?.file_path;
			parts.push(`[ran ${block.name}${typeof path === "string" && path ? ` on ${path}` : ""}]`);
		}
	}
	return parts.join("\n");
}

interface RawEntry {
	type?: unknown;
	id?: unknown;
	parentId?: unknown;
	message?: { role?: unknown; content?: unknown };
}

/**
 * Render a session JSONL file to the plain text the ghost call reads.
 *
 * Follows the **active branch only**: the file is append-ordered and entries carry
 * `parentId`, so walking parents up from the last entry excludes anything the user
 * rewound away from via `/tree` — the same reasoning as the digest's `getBranch()`
 * (see index.ts). Tool results and custom messages (injected briefings) are dropped;
 * user text, assistant text, and tool-call markers carry the story.
 *
 * Returns "" when the file contains no usable messages.
 */
export function renderTranscript(content: string): string {
	const entries: RawEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as RawEntry);
		} catch {
			// Skip malformed lines, matching pi's own parseSessionEntries.
		}
	}

	const byId = new Map<string, RawEntry>();
	let leaf: RawEntry | undefined;
	for (const entry of entries) {
		if (typeof entry.id !== "string") continue;
		byId.set(entry.id, entry);
		if (entry.type !== "session") leaf = entry;
	}

	const branch: RawEntry[] = [];
	for (let current = leaf; current; ) {
		branch.push(current);
		current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
	}
	branch.reverse();

	const lines: string[] = [];
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = contentToText(entry.message?.content);
		if (!text) continue;
		lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
	}
	return truncateTranscript(lines.join("\n\n"));
}

/** Exported for tests; callers get it applied by `renderTranscript`. */
export function truncateTranscript(text: string): string {
	if (text.length <= TRANSCRIPT_CHARS) return text;
	const tail = text.slice(-TRANSCRIPT_CHARS);
	// Start at the next full line so the ghost never reads half a sentence as a fact.
	const firstBreak = tail.indexOf("\n");
	return `${TRUNCATION_MARKER}\n\n${firstBreak === -1 ? tail : tail.slice(firstBreak + 1)}`;
}

export const GHOST_SYSTEM_PROMPT = `You are answering on behalf of a previous pi coding session, from its transcript. A successor session is asking clarifying questions so it can continue the work.

Rules:
- Answer only from the transcript. If it does not contain the answer, say so plainly — never guess or invent details.
- Be specific: cite files, commands, decisions, and reasons exactly as they appear.
- Be concise. The asker is an agent that needs facts, not narrative.`;

export function buildGhostUserMessage(transcriptText: string, question: string): string {
	return `## Transcript of the previous session\n\n${transcriptText}\n\n## Question from the successor session\n\n${question}`;
}

export interface GhostOptions {
	modelRegistry: ModelRegistry;
	model: Model<any>;
	transcriptText: string;
	question: string;
	signal?: AbortSignal;
	/** Isolates the ghost call from the asking session's cache and context. */
	sessionId: string;
}

/** Same three-way outcome split, for the same reasons, as `composeNoteBody`. */
export type GhostResult =
	| { status: "ok"; answer: string }
	| { status: "aborted" }
	| { status: "failed"; message: string };

export async function answerAsPredecessor(options: GhostOptions): Promise<GhostResult> {
	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: buildGhostUserMessage(options.transcriptText, options.question) }],
		timestamp: Date.now(),
	};

	const response = await options.modelRegistry.complete(
		options.model,
		{ systemPrompt: GHOST_SYSTEM_PROMPT, messages: [userMessage] },
		{ signal: options.signal, cacheRetention: "none", sessionId: options.sessionId },
	);

	if (response.stopReason === "aborted") return { status: "aborted" };
	if (response.stopReason === "error") {
		return { status: "failed", message: response.errorMessage ?? "the provider reported an error with no message" };
	}

	const text = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (!text) return { status: "failed", message: `the model returned no text (stop reason: ${response.stopReason})` };

	return { status: "ok", answer: text };
}
