import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SystemMessage, Tool } from "@earendil-works/pi-ai/compat";
import {
	type BuildSystemPromptOptions,
	buildSystemPromptPieces,
	diffSystemPrompts,
	renderSystemPrompt,
	type SystemPromptPiece,
} from "./system-prompt.ts";

export interface ModelContextState {
	prompt: {
		pieces: SystemPromptPiece[];
		baseline: string;
	};
	tools: Map<string, Tool>;
}

export type PreparedModelContextUpdate =
	| { type: "initial" | "unchanged" | "replacement"; state: ModelContextState }
	| {
			type: "incremental";
			state: ModelContextState;
			promptText?: string;
			toolsAdded: Tool[];
			toolsRemoved: Tool[];
	  };

/** Convert an executable agent tool into the provider-independent declaration stored in prompt updates. */
export function systemPromptTool(tool: AgentTool): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		constrainedSampling: tool.constrainedSampling,
	};
}

/**
 * Prepare one prompt and tool transition for the next provider request.
 *
 * Tool changes are a set difference by name. A tool whose definition changed
 * while staying active is not re-declared: providers keep the first definition
 * they saw, because replacing a declaration would change the cached prefix.
 */
export function prepareModelContextUpdate(input: {
	options: BuildSystemPromptOptions;
	tools: Map<string, Tool>;
	previous?: ModelContextState;
}): PreparedModelContextUpdate {
	const { options, tools, previous } = input;
	const pieces = buildSystemPromptPieces(options);
	const currentPrompt = renderSystemPrompt(pieces);
	if (!previous) {
		return {
			type: "initial",
			state: { prompt: { pieces, baseline: currentPrompt }, tools },
		};
	}

	const promptDiff =
		renderSystemPrompt(previous.prompt.pieces) === currentPrompt
			? ({ type: "unchanged" } as const)
			: diffSystemPrompts(previous.prompt.pieces, pieces);
	const toolsAdded = [...tools].filter(([name]) => !previous.tools.has(name)).map(([, tool]) => tool);
	const toolsRemoved = [...previous.tools].filter(([name]) => !tools.has(name)).map(([, tool]) => tool);

	if (promptDiff.type === "replace" || (options.forceSystemPrompt !== undefined && promptDiff.type !== "unchanged")) {
		return {
			type: "replacement",
			state: { prompt: { pieces, baseline: currentPrompt }, tools },
		};
	}

	if (promptDiff.type === "unchanged" && toolsAdded.length === 0 && toolsRemoved.length === 0) {
		return {
			type: "unchanged",
			state: { prompt: { pieces, baseline: previous.prompt.baseline }, tools },
		};
	}

	return {
		type: "incremental",
		state: { prompt: { pieces, baseline: previous.prompt.baseline }, tools },
		promptText: promptDiff.type === "update" ? promptDiff.text : undefined,
		toolsAdded,
		toolsRemoved,
	};
}

/** Serialize one incremental prompt/tool transition into a provider-independent system message. */
export function createSystemPromptUpdateMessage(
	update: Extract<PreparedModelContextUpdate, { type: "incremental" }>,
): SystemMessage {
	const text = update.promptText ? [update.promptText] : [];
	if (update.toolsAdded.length > 0) {
		text.push(
			`The following tools are now available and may be used: ${update.toolsAdded.map((tool) => tool.name).join(", ")}.`,
		);
	}
	if (update.toolsRemoved.length > 0) {
		text.push(
			`The following tools are no longer available. Do not call them; such calls will be rejected: ${update.toolsRemoved.map((tool) => tool.name).join(", ")}.`,
		);
	}
	return {
		role: "system",
		content: text.join("\n\n"),
		toolsAdded: update.toolsAdded.length > 0 ? update.toolsAdded : undefined,
		toolsRemoved: update.toolsRemoved.length > 0 ? update.toolsRemoved : undefined,
		timestamp: Date.now(),
	};
}
