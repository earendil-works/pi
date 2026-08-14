import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	TRANSCRIPT_BLOCK,
	type TranscriptTarget,
	type TranscriptBlockComponent as TuiTranscriptBlockComponent,
} from "@earendil-works/pi-tui";
import type { SessionMessageEntry } from "../../core/session-manager.ts";

export interface MessageTranscriptMetadata {
	readonly entry?: SessionMessageEntry;
	readonly message: AgentMessage;
}

export interface ToolTranscriptMetadata {
	readonly entry: SessionMessageEntry;
	readonly message: AssistantMessage;
	readonly toolCall: ToolCall;
	readonly resultEntry?: SessionMessageEntry;
	readonly result?: ToolResultMessage;
}

/** One semantic transcript block whose visual content may contain several components. */
export class TranscriptBlockComponent extends Container implements TuiTranscriptBlockComponent {
	private target: TranscriptTarget;

	constructor(target: TranscriptTarget, components: readonly Component[]) {
		super();
		this.target = target;
		for (const component of components) this.addChild(component);
	}

	setMetadata(metadata: unknown): void {
		this.target = { ...this.target, metadata };
	}

	[TRANSCRIPT_BLOCK](): TranscriptTarget {
		return this.target;
	}
}

export function createMessageTranscriptTarget(
	id: string,
	kind: "user" | "assistant",
	message: AgentMessage,
	entry?: SessionMessageEntry,
): TranscriptTarget {
	const metadata: MessageTranscriptMetadata = { ...(entry ? { entry } : {}), message };
	return { id, kind, metadata };
}

export function createToolTranscriptTarget(id: string, metadata: ToolTranscriptMetadata): TranscriptTarget {
	return { id, kind: "tool", metadata };
}
