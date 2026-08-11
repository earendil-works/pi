/**
 * `/handoff` composition: turn the current conversation into a rich handoff note
 * with one throwaway LLM call.
 *
 * The call is deliberately isolated from the user's session — its own `sessionId` and
 * `cacheRetention: "none"` — so composing a note never pollutes the conversation's
 * cache or context.
 *
 * Every pi import here is type-only, which keeps this module unit-testable without
 * pulling pi's runtime module graph into the test process.
 */

import type { Message, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Trailing marker the model uses to hand back the successor's opening prompt. */
const KICKOFF_MARKER = /^KICKOFF:[ \t]*(.+)$/;

export const COMPOSE_SYSTEM_PROMPT = `You are writing a handoff note for the next coding session. The next session starts with no memory of this conversation and will read only your note.

Output Markdown with exactly these three sections, in this order:

## Context
What we were doing and why. Decisions made and the reasoning behind them, approaches ruled out, and anything discovered the hard way. Be specific: name files, functions, commands, and error messages.

## Next steps
The concrete task the next session should pick up, stated so it can act without asking questions.

## Files touched
A bullet list of the files read and the files modified, with a few words on what changed in each.

Then, as the very last line and nothing after it, output:

KICKOFF: <a single sentence that could be typed as the next session's opening prompt>

Rules:
- No preamble, no closing remarks, no code fences around the whole note. Start with "## Context".
- Prefer concrete detail over summary. The next session cannot ask you follow-up questions.
- Do not invent work that did not happen. If a section has nothing to report, say so in one line.`;

export function buildComposeUserMessage(conversationText: string, goal: string): string {
	const instruction = goal
		? `## What the next session should focus on\n\n${goal}\n\nUse this to write the "Next steps" section.`
		: `## What the next session should focus on\n\nNo goal was given. Infer the natural next step from where the conversation left off, and say plainly if the work reached a stopping point.`;
	return `## Conversation history\n\n${conversationText}\n\n${instruction}`;
}

/**
 * Split the trailing `KICKOFF:` line off the note body. Returns kickoff undefined when
 * the model omitted it; callers supply their own fallback rather than failing.
 */
export function splitKickoff(text: string): { body: string; kickoff?: string } {
	const lines = text.trimEnd().split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line === "" || line === "---") continue;
		const match = KICKOFF_MARKER.exec(line);
		if (!match) break;
		return { body: lines.slice(0, i).join("\n").trimEnd(), kickoff: match[1].trim() };
	}
	return { body: text.trim() };
}

/**
 * Inverse of `splitKickoff`: fold the note back into one editable document. `/handoff`
 * hands this to the editor so the kickoff is reviewed alongside the body it belongs to,
 * then re-splits the result. Kept beside `splitKickoff` so the two halves of the format
 * cannot drift apart.
 */
export function joinKickoff(body: string, kickoff: string | undefined): string {
	return kickoff ? `${body}\n\nKICKOFF: ${kickoff}` : body;
}

export interface ComposeOptions {
	modelRegistry: ModelRegistry;
	model: Model<any>;
	conversationText: string;
	goal: string;
	signal?: AbortSignal;
	/** Isolates the composition call from the user's session cache and context. */
	sessionId: string;
}

/**
 * Failure and cancellation are separate outcomes on purpose. `complete()` never rejects:
 * it resolves with `stopReason: "error"` and the reason in `errorMessage`, so collapsing
 * both into one empty result would report a provider failure as "cancelled" and throw the
 * real message away — exactly what a long session near its context ceiling would hit.
 */
export type ComposeResult =
	| { status: "ok"; body: string; kickoff?: string }
	| { status: "aborted" }
	| { status: "failed"; message: string };

export async function composeNoteBody(options: ComposeOptions): Promise<ComposeResult> {
	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: buildComposeUserMessage(options.conversationText, options.goal) }],
		timestamp: Date.now(),
	};

	const response = await options.modelRegistry.complete(
		options.model,
		{ systemPrompt: COMPOSE_SYSTEM_PROMPT, messages: [userMessage] },
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

	return { status: "ok", ...splitKickoff(text) };
}
