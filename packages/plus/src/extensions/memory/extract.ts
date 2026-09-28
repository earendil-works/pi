/**
 * Background auto-extraction of memories (adapted from openclaude's
 * extractMemories service): when a user prompt settles, a forked pi
 * sub-agent — restricted to the memory_save / memory_recall tools — reviews
 * the conversation and persists anything worth remembering, so the main
 * agent does not have to spend turns on it.
 *
 * The extractor runs fire-and-forget: failures are silent, it never blocks
 * the session, and it is skipped when the main agent already saved a memory
 * during the run (mutual exclusion with the model's own judgement).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "../../../../coding-agent/src/core/extensions/types.ts";
import type { AgentConfig } from "../subagent/agents.ts";
import { runSingleAgent } from "../subagent/run.ts";
import { readMemorySettings } from "./settings.ts";
import type { MemoryStore } from "./store.ts";

export interface ExtractState {
	/** Set when the main agent called memory_save during the current run. */
	mainAgentSavedThisRun: boolean;
	/** Date.now() of the last extraction attempt (success or failure). */
	lastExtractAt: number;
	/** Projected message count at the last extraction attempt. */
	lastExtractMessageCount: number;
	/** Guard against overlapping extractions. */
	running: boolean;
}

export function createExtractState(): ExtractState {
	return { mainAgentSavedThisRun: false, lastExtractAt: 0, lastExtractMessageCount: 0, running: false };
}

export interface ExtractDeps {
	storeFor(ctx: ExtensionContext): MemoryStore;
	/** Injectable for tests; defaults to the real sub-agent runner. */
	runAgent?: typeof runSingleAgent;
}

const EXTRACT_TIMEOUT_MS = 120_000;
const MAX_MESSAGES = 60;
const MAX_TOOL_RESULT_CHARS = 500;
const MAX_TASK_BYTES = 50_000;

const EXTRACTOR_AGENT: AgentConfig = {
	name: "memory-extractor",
	description: "Saves noteworthy memories from a finished conversation",
	tools: ["memory_save", "memory_recall"],
	systemPrompt: [
		"You are a memory extractor for a coding agent. You receive a conversation transcript between a user and",
		"an agent, plus the current memory index for the project.",
		"",
		"Review the transcript and save 0 or more memories with the memory_save tool. Only save what is durable",
		"and useful across sessions:",
		"- user: the user's role, goals, and preferences (tools, style, workflow).",
		"- feedback: guidance the user gave — corrections to the agent's behavior and approaches they confirmed.",
		"- project: ongoing work context, conventions, and decisions not derivable from the code.",
		"- reference: stable pointers to external systems (issue trackers, dashboards, docs).",
		"",
		"Never save secrets, credentials, tokens, or session-scoped state. Prefer UPDATING an existing memory",
		'(same name) over creating a near-duplicate when the index already covers the topic. For "feedback" and',
		'"project" memories the body must include "**Why:**" and "**How to apply:**" paragraphs.',
		"",
		'If nothing is noteworthy, save nothing and output exactly "No memories to save."',
	].join("\n"),
	source: "builtin",
	filePath: "",
};

/** Render one projected message as a compact `role: text` line for the extractor prompt. */
function renderMessage(message: AgentMessage): string | null {
	// Custom session messages (bash execution summaries, custom entries, …)
	// carry no role/content; only LLM messages are useful to the extractor.
	const m = message as Message;
	if (m.role === "system") return null;
	if (m.role === "user") {
		const text = extractText(m.content);
		return text ? `user: ${truncate(text, MAX_TOOL_RESULT_CHARS)}` : null;
	}
	if (m.role === "assistant") {
		const parts: string[] = [];
		const text = extractText(m.content);
		if (text) parts.push(text);
		for (const block of m.content) {
			if (block.type === "toolCall") parts.push(`[called tool ${block.name}]`);
		}
		return parts.length > 0 ? `assistant: ${truncate(parts.join(" "), MAX_TOOL_RESULT_CHARS)}` : null;
	}
	// toolResult
	const text = extractText(m.content);
	return text ? `tool (${m.toolName}): ${truncate(text, MAX_TOOL_RESULT_CHARS)}` : null;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

async function buildExtractionTask(ctx: ExtensionContext, store: MemoryStore): Promise<string> {
	const index = (await store.readIndex()).trim();
	let messages: AgentMessage[] = [];
	try {
		messages = ctx.sessionManager.buildSessionProjection().messages;
	} catch {
		/* extraction without a transcript saves nothing */
	}
	const lines: string[] = [];
	for (const message of messages.slice(-MAX_MESSAGES)) {
		const rendered = renderMessage(message);
		if (rendered) lines.push(rendered);
	}
	let transcript = lines.join("\n");
	// argv budget for the spawned process (the task is passed as an argument).
	if (Buffer.byteLength(transcript, "utf-8") > MAX_TASK_BYTES) {
		transcript = transcript.slice(0, MAX_TASK_BYTES);
	}
	return [
		`Current memory index for this project:\n${index || "(no memories yet)"}`,
		"",
		`Conversation transcript (most recent last):\n${transcript || "(empty)"}`,
	].join("\n");
}

/**
 * Decide whether to auto-extract and, if so, spawn the extractor
 * fire-and-forget. Never throws and never blocks the caller.
 */
export function maybeExtract(ctx: ExtensionContext, state: ExtractState, deps: ExtractDeps): void {
	if (state.running) return;
	// Non-interactive modes skip: no background extraction for one-shot runs,
	// and this also prevents recursion (the extractor child runs in json mode).
	if (ctx.mode === "json" || ctx.mode === "print") return;
	const settings = readMemorySettings(ctx.cwd);
	if (!settings.enabled || !settings.autoExtract) return;
	if (state.mainAgentSavedThisRun) return;

	let messageCount = 0;
	try {
		messageCount = ctx.sessionManager.buildSessionProjection().messages.length;
	} catch {
		return;
	}
	if (messageCount - state.lastExtractMessageCount < settings.extractMinMessages) return;
	if (Date.now() - state.lastExtractAt < settings.extractCooldownMs) return;

	// Commit the throttle state before spawning so a failed extraction still
	// counts against rate limiting.
	state.lastExtractAt = Date.now();
	state.lastExtractMessageCount = messageCount;
	state.running = true;

	const runner = deps.runAgent ?? runSingleAgent;
	void (async () => {
		try {
			const store = deps.storeFor(ctx);
			const task = await buildExtractionTask(ctx, store);
			await runner(
				ctx.cwd,
				{ model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined },
				EXTRACTOR_AGENT,
				task,
				ctx.cwd,
				AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
				undefined,
			);
		} catch {
			/* extraction is best-effort; failures stay silent */
		} finally {
			state.running = false;
		}
	})();
}
