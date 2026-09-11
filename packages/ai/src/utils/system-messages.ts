import type { Api, Context, Message, Model, SystemMessage } from "../types.ts";

export interface TranscriptCapabilities {
	midConversationSystemMessages: boolean;
	midConversationToolAdditions: boolean;
	midConversationToolRemovals: boolean;
}

const NO_TRANSCRIPT_CAPABILITIES: TranscriptCapabilities = {
	midConversationSystemMessages: false,
	midConversationToolAdditions: false,
	midConversationToolRemovals: false,
};

const RESPONSES_APIS: ReadonlySet<Api> = new Set([
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
]);

/** Report native transcript semantics for a model, excluding lossy fallback handling. */
export function getTranscriptCapabilities(model: Model<Api>): TranscriptCapabilities {
	const compat = model.compat as
		| {
				supportsAdditionalTools?: boolean;
				supportsToolSearch?: boolean;
				deferredToolsMode?: "kimi";
				supportsMidConvoSystemMessages?: boolean;
				supportsMidConvoToolChanges?: boolean;
		  }
		| undefined;

	if (compat?.supportsMidConvoSystemMessages === true) {
		return {
			midConversationSystemMessages: true,
			midConversationToolAdditions: compat.supportsMidConvoToolChanges === true,
			midConversationToolRemovals: compat.supportsMidConvoToolChanges === true,
		};
	}
	if (RESPONSES_APIS.has(model.api)) {
		return {
			midConversationSystemMessages: true,
			midConversationToolAdditions: compat?.supportsAdditionalTools === true || compat?.supportsToolSearch === true,
			midConversationToolRemovals: compat?.supportsAdditionalTools === true,
		};
	}
	if (model.api === "kimi-coding" || compat?.deferredToolsMode === "kimi") {
		return {
			midConversationSystemMessages: true,
			midConversationToolAdditions: true,
			midConversationToolRemovals: false,
		};
	}
	if (model.api === "openai-completions" || model.api === "mistral-conversations") {
		return {
			midConversationSystemMessages: true,
			midConversationToolAdditions: false,
			midConversationToolRemovals: false,
		};
	}
	return NO_TRANSCRIPT_CAPABILITIES;
}

/** Whether the model natively supports complete mid-conversation tool replacement semantics. */
export function supportsMidConversationToolChanges(model: Model<Api>): boolean {
	const capabilities = getTranscriptCapabilities(model);
	return capabilities.midConversationToolAdditions && capabilities.midConversationToolRemovals;
}

/** Names made available at a system transition or deprecated tool-result marker. */
export function addedToolNames(message: Message): string[] {
	if (message.role === "system") return (message.toolsAdded ?? []).map((tool) => tool.name);
	if (message.role === "toolResult") return [...new Set(message.addedToolNames ?? [])];
	return [];
}

/** Extract the instruction text carried by a system-message transition. */
export function getSystemMessageText(message: SystemMessage): string {
	return typeof message.content === "string" ? message.content : message.content.map((block) => block.text).join("\n");
}

/**
 * Map a leading system message to a transport's top-level system channel when
 * no explicit top-level prompt exists. Tool changes remain on the message.
 */
export function extractInitialSystemPrompt(context: Context): Context {
	if (context.systemPrompt) return context;
	const first = context.messages[0];
	if (first?.role !== "system") return context;
	const text = getSystemMessageText(first);
	if (!text) return context;
	return {
		...context,
		systemPrompt: text,
		messages: [{ ...first, content: "" }, ...context.messages.slice(1)],
	};
}

/**
 * Render a system-message transition for APIs without a native system role.
 * Tool changes remain provider-side metadata and are not embedded in user-visible text.
 */
export function renderSystemMessageAsUserText(message: SystemMessage): string {
	const text = getSystemMessageText(message);
	return text ? `<system_update>\n${text}\n</system_update>` : "";
}
