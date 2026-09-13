import type { Api, Model, SystemMessage, Tool, TranscriptContext } from "../types.ts";
import { getCurrentTools, getInitialSystemMessage, getInitialTools } from "./normalize-context.ts";

export interface TranscriptCapabilities {
	midConversationSystemMessages: boolean;
	midConversationToolAdditions: boolean;
	midConversationToolRemovals: boolean;
}

export interface ResolvedTranscriptTools {
	requestTools: Tool[];
	getAdditions(message: SystemMessage): Tool[];
}

type TranscriptCompat = {
	supportsAdditionalTools?: boolean;
	supportsToolSearch?: boolean;
	supportsMidConvoSystemMessages?: boolean;
	supportsMidConvoToolChanges?: boolean;
	supportsMidConvoToolAdditions?: boolean;
};

const RESPONSES_APIS = new Set<Api>(["openai-responses", "azure-openai-responses", "openai-codex-responses"]);

/** Capabilities that preserve transcript position without rewriting the initial provider state. */
export function getTranscriptCapabilities(model: Model<Api>): TranscriptCapabilities {
	const compat = model.compat as TranscriptCompat | undefined;
	const nativeTranscript = model.api === "pi-messages" || model.api.startsWith("faux:");
	const anthropicSystem = model.api === "anthropic-messages" && compat?.supportsMidConvoSystemMessages === true;
	const anthropicTools = anthropicSystem && compat?.supportsMidConvoToolChanges === true;
	const responses = RESPONSES_APIS.has(model.api);
	const completionsTools = model.api === "openai-completions" && compat?.supportsMidConvoToolAdditions === true;

	return {
		midConversationSystemMessages:
			nativeTranscript ||
			responses ||
			anthropicSystem ||
			model.api === "openai-completions" ||
			model.api === "mistral-conversations",
		midConversationToolAdditions:
			nativeTranscript ||
			anthropicTools ||
			completionsTools ||
			(responses && (compat?.supportsAdditionalTools === true || compat?.supportsToolSearch === true)),
		midConversationToolRemovals: nativeTranscript || anthropicTools,
	};
}

/** Every definition referenced by transcript tool state, in first-declaration order. */
export function getDeclaredTools(context: TranscriptContext): Tool[] {
	const definitions = new Map<string, Tool>();
	for (const message of context.messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) definitions.set(tool.name, tool);
	}
	return [...definitions.values()];
}

/** Whether the transcript contains a tool removal after its initial declaration. */
export function hasMidConversationToolRemovals(context: TranscriptContext): boolean {
	const initial = getInitialSystemMessage(context);
	return context.messages.some(
		(message) => message.role === "system" && message !== initial && (message.toolsRemoved?.length ?? 0) > 0,
	);
}

/** Resolve top-level declarations and native additions directly from transcript system messages. */
export function resolveTranscriptTools(
	context: TranscriptContext,
	supportsToolAdditions: boolean,
): ResolvedTranscriptTools {
	if (!supportsToolAdditions || hasMidConversationToolRemovals(context)) {
		return { requestTools: getCurrentTools(context), getAdditions: () => [] };
	}

	const requestTools = getInitialTools(context);
	const loadedNames = new Set(requestTools.map((tool) => tool.name));
	return {
		requestTools,
		getAdditions(message) {
			const additions: Tool[] = [];
			for (const tool of message.toolsAdded ?? []) {
				if (loadedNames.has(tool.name)) continue;
				loadedNames.add(tool.name);
				additions.push(tool);
			}
			return additions;
		},
	};
}
