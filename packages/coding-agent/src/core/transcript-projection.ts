import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ReadonlySessionManager, SessionEntry, SessionMessageEntry } from "./session-manager.ts";

export interface TranscriptEntryBlock {
	kind: "entry";
	id: string;
	entryId: string;
	entry: SessionEntry;
}

export interface TranscriptAssistantBlock {
	kind: "assistant";
	id: string;
	entryId: string;
	entry: SessionMessageEntry;
	message: AssistantMessage;
}

export interface TranscriptToolBlock {
	kind: "tool";
	id: string;
	entryId: string;
	entry: SessionMessageEntry;
	contentIndex: number;
	toolCall: ToolCall;
	resultEntry?: SessionMessageEntry;
	result?: ToolResultMessage;
}

export type TranscriptBlock = TranscriptEntryBlock | TranscriptAssistantBlock | TranscriptToolBlock;

export interface TranscriptProjection {
	blocks: TranscriptBlock[];
	unpairedToolResults: Array<{
		entry: SessionMessageEntry;
		result: ToolResultMessage;
	}>;
}

function entryBlockId(entryId: string): string {
	return `entry:${encodeURIComponent(entryId)}`;
}

/**
 * Project the full active human transcript into stable source blocks.
 *
 * The source must be SessionManager.getBranch(), not buildContextEntries():
 * compaction changes model context but must not erase the human transcript.
 * Rendering details remain outside this module; one source block may own a
 * component group (for example, a skill invocation and its user message).
 */
export function buildTranscriptProjection(session: Pick<ReadonlySessionManager, "getBranch">): TranscriptProjection {
	return buildTranscriptProjectionFromEntries(session.getBranch());
}

/** Project an already-validated contiguous active-branch segment. */
export function buildTranscriptProjectionFromEntries(entries: readonly SessionEntry[]): TranscriptProjection {
	const blocks: TranscriptBlock[] = [];
	const pendingTools = new Map<string, TranscriptToolBlock>();
	const unpairedToolResults: TranscriptProjection["unpairedToolResults"] = [];

	for (const entry of entries) {
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				blocks.push({
					kind: "assistant",
					id: `${entryBlockId(entry.id)}:assistant`,
					entryId: entry.id,
					entry,
					message,
				});

				const toolCallOccurrences = new Map<string, number>();
				for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
					const content = message.content[contentIndex];
					if (content?.type !== "toolCall") continue;

					const occurrence = toolCallOccurrences.get(content.id) ?? 0;
					toolCallOccurrences.set(content.id, occurrence + 1);
					const block: TranscriptToolBlock = {
						kind: "tool",
						id: `${entryBlockId(entry.id)}:tool:${encodeURIComponent(content.id)}:${occurrence}`,
						entryId: entry.id,
						entry,
						contentIndex,
						toolCall: content,
					};
					blocks.push(block);
					// Match the eager renderer: a later duplicate call ID replaces the
					// pending lookup, while both call blocks remain visible.
					pendingTools.set(content.id, block);
				}
				continue;
			}

			if (message.role === "toolResult") {
				const toolBlock = pendingTools.get(message.toolCallId);
				if (toolBlock) {
					toolBlock.resultEntry = entry;
					toolBlock.result = message;
					pendingTools.delete(message.toolCallId);
				} else {
					unpairedToolResults.push({ entry, result: message });
				}
				continue;
			}

			blocks.push({ kind: "entry", id: entryBlockId(entry.id), entryId: entry.id, entry });
			continue;
		}

		switch (entry.type) {
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
				blocks.push({ kind: "entry", id: entryBlockId(entry.id), entryId: entry.id, entry });
				break;
			case "thinking_level_change":
			case "model_change":
			case "label":
			case "session_info":
				break;
			default: {
				const _exhaustive: never = entry;
				return _exhaustive;
			}
		}
	}

	return { blocks, unpairedToolResults };
}
