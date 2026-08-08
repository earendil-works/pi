import type { AssistantMessage, Message, Model, TextContent } from "@earendil-works/pi-ai";
import { Agent } from "./agent.ts";
import { extractJson } from "./harness/tools/index.ts";
import type { AgentContext, AgentMessage, StreamFn } from "./types.ts";

/**
 * An advisor observes the agent's latest assistant turn and may return a short
 * corrective note when the agent drifts from the user's goal, gets stuck, or
 * makes a mistake worth correcting. The note is injected into the next turn's
 * context as a lightweight steer message (one-shot, does not burn context on
 * every turn).
 */
export interface Advisor {
	/**
	 * Evaluate the latest assistant turn.
	 * @returns a corrective note, or undefined when no correction is needed.
	 */
	evaluate(context: AgentContext, message: AssistantMessage, signal?: AbortSignal): Promise<string | undefined>;
}

/** Options for constructing an advisor. */
export interface AdvisorOptions {
	/** Model used by the advisor. Usually a cheap/fast model. */
	model: Model<any>;
	/** Stream function used by the advisor. */
	streamFn: StreamFn;
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** System prompt for the advisor. */
	systemPrompt?: string;
}

const DEFAULT_SYSTEM_PROMPT =
	'You are a careful advisor embedded in an AI coding agent. You watch for goal drift, getting stuck, and mistakes that would waste a turn. Be concise and specific. Respond with ONLY a JSON object: {"needsCorrection": true|false, "note": "brief corrective guidance or empty string"}.';

function advisorPrompt(context: AgentContext, message: AssistantMessage): string {
	const userGoal = context.messages.find((m) => m.role === "user");
	const goalText =
		userGoal && "content" in userGoal
			? Array.isArray(userGoal.content)
				? userGoal.content.map((c) => ("text" in c && typeof c.text === "string" ? c.text : "")).join("\n")
				: String(userGoal.content)
			: "";
	const assistantText = message.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	return [
		"Review the latest assistant turn of a coding agent against the user's goal.",
		"",
		"USER GOAL:",
		goalText || "(none)",
		"",
		"LATEST ASSISTANT TURN:",
		assistantText || "(no text output)",
		"",
		"Is the assistant drifting from the goal, stuck, or making a mistake worth correcting right now?",
		'Reply with ONLY JSON: {"needsCorrection": true|false, "note": "brief corrective guidance or empty string"}',
		"Return only the JSON, no prose.",
	].join("\n");
}

function parseAdvisorOutput(text: string): { needsCorrection: boolean; note: string } {
	const raw = extractJson(text) as { needsCorrection?: unknown; note?: unknown } | undefined;
	if (!raw || typeof raw !== "object") {
		return { needsCorrection: false, note: "" };
	}
	return {
		needsCorrection: raw.needsCorrection === true,
		note: typeof raw.note === "string" ? raw.note : "",
	};
}

/**
 * Creates an advisor that runs a lightweight secondary model over the latest
 * assistant turn and returns a corrective note on goal drift.
 */
export function createAdvisor(options: AdvisorOptions): Advisor {
	const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
	return {
		async evaluate(context, message, signal): Promise<string | undefined> {
			const agent = new Agent({
				streamFn: options.streamFn,
				convertToLlm: options.convertToLlm,
				getApiKey: options.getApiKey,
				initialState: {
					model: options.model,
					systemPrompt,
					tools: [],
					thinkingLevel: "off",
					messages: [],
				},
			});
			if (signal) {
				if (signal.aborted) {
					return undefined;
				}
				signal.addEventListener("abort", () => agent.abort(), { once: true });
			}
			await agent.prompt(advisorPrompt(context, message));
			const text = agent.state.messages
				.filter((m): m is AssistantMessage => m.role === "assistant")
				.flatMap((m) => m.content)
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const parsed = parseAdvisorOutput(text);
			return parsed.needsCorrection && parsed.note.trim().length > 0 ? parsed.note.trim() : undefined;
		},
	};
}
