import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SystemMessage, Tool, ToolReference, TranscriptCapabilities } from "@earendil-works/pi-ai";
import {
	buildSystemPromptPieces,
	diffSystemPrompts,
	type NormalizedBuildSystemPromptOptions,
	renderSystemPrompt,
	type SystemPromptPiece,
} from "./system-prompt.ts";

export interface ModelContextState {
	prompt: {
		pieces: SystemPromptPiece[];
		baseline: string;
	};
	tools: Map<string, Tool>;
	initialTools: Tool[];
	hasTranscriptUpdates: boolean;
	modelKey: string;
}

export type PreparedModelContextUpdate =
	| { type: "unchanged"; state: ModelContextState }
	| {
			type: "initial" | "incremental" | "replacement";
			state: ModelContextState;
			promptText?: string;
			toolsAdded: Tool[];
			toolsRemoved: ToolReference[];
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

/** Prepare one coherent prompt and tool transition for the next provider request. */
export function prepareModelContextUpdate(input: {
	options: NormalizedBuildSystemPromptOptions;
	tools: Map<string, Tool>;
	previous?: ModelContextState;
	capabilities: TranscriptCapabilities;
	modelKey: string;
}): PreparedModelContextUpdate {
	const { options, tools, previous, capabilities, modelKey } = input;
	const pieces = buildSystemPromptPieces(options);
	const currentPrompt = renderSystemPrompt(pieces);
	if (!previous) {
		return {
			type: "initial",
			state: {
				prompt: { pieces, baseline: currentPrompt },
				tools,
				initialTools: [...tools.values()],
				hasTranscriptUpdates: false,
				modelKey,
			},
			promptText: currentPrompt,
			toolsAdded: [...tools.values()],
			toolsRemoved: [],
		};
	}

	const promptDiff = diffSystemPrompts(previous.prompt.pieces, pieces);
	const toolDefinitionsChanged = [...tools].some(([name, tool]) => {
		const oldTool = previous.tools.get(name);
		return oldTool !== undefined && JSON.stringify(oldTool) !== JSON.stringify(tool);
	});
	const toolsAdded = [...tools]
		.filter(([name, tool]) => {
			const oldTool = previous.tools.get(name);
			return oldTool === undefined || JSON.stringify(oldTool) !== JSON.stringify(tool);
		})
		.map(([, tool]) => tool);
	const toolsRemoved = [...previous.tools]
		.filter(([name, tool]) => {
			const newTool = tools.get(name);
			return newTool === undefined || JSON.stringify(tool) !== JSON.stringify(newTool);
		})
		.map(([name]) => ({ name }));

	if (
		previous.modelKey === modelKey &&
		promptDiff.type === "unchanged" &&
		!toolDefinitionsChanged &&
		toolsAdded.length === 0 &&
		toolsRemoved.length === 0
	) {
		return {
			type: "unchanged",
			state: {
				prompt: { pieces, baseline: previous.prompt.baseline },
				tools,
				initialTools: previous.initialTools,
				hasTranscriptUpdates: previous.hasTranscriptUpdates,
				modelKey,
			},
		};
	}

	const canUpdatePrompt = promptDiff.type === "unchanged" || capabilities.midConversationSystemMessages;
	const canAddTools = toolsAdded.length === 0 || capabilities.midConversationToolAdditions;
	const canRemoveTools = toolsRemoved.length === 0 || capabilities.midConversationToolRemovals;
	if (
		previous.modelKey !== modelKey ||
		toolDefinitionsChanged ||
		promptDiff.type === "replace" ||
		!canUpdatePrompt ||
		!canAddTools ||
		!canRemoveTools
	) {
		return {
			type: "replacement",
			state: {
				prompt: { pieces, baseline: previous.prompt.baseline },
				tools,
				initialTools: previous.initialTools,
				hasTranscriptUpdates: true,
				modelKey,
			},
			promptText: `The following is the complete current system prompt. It supersedes all earlier system prompt updates:\n\n${currentPrompt}`,
			toolsAdded,
			toolsRemoved,
		};
	}

	return {
		type: "incremental",
		state: {
			prompt: { pieces, baseline: previous.prompt.baseline },
			tools,
			initialTools: previous.initialTools,
			hasTranscriptUpdates: true,
			modelKey,
		},
		promptText: promptDiff.type === "update" ? promptDiff.text : undefined,
		toolsAdded,
		toolsRemoved,
	};
}

/** Serialize one prompt/tool transition into a provider-independent system message. */
export function createSystemPromptUpdateMessage(
	update: Exclude<PreparedModelContextUpdate, { type: "unchanged" }>,
): SystemMessage {
	const text = update.promptText ? [update.promptText] : [];
	if (update.type !== "initial" && update.toolsAdded.length > 0) {
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
		toolsAdded: update.type === "initial" || update.toolsAdded.length > 0 ? update.toolsAdded : undefined,
		toolsRemoved: update.toolsRemoved.length > 0 ? update.toolsRemoved : undefined,
		timestamp: Date.now(),
	};
}
