// Frozen compaction inputs and branch checks; the session owns generation, cancellation, and application.
import type { Model } from "@earendil-works/pi-ai";
import { buildSessionProjection, type SessionEntry, type SessionManager } from "../session-manager.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	prepareCompaction,
} from "./compaction.ts";

export const CONTEXT_CHECKPOINT_TYPE = "context_checkpoint";

export type BackgroundCompactionOutcome =
	| { kind: "ready"; result: CompactionResult; fromExtension: boolean }
	| { kind: "failed"; error: string; aborted: boolean; fromExtension: boolean };

export interface BackgroundCompaction {
	checkpointId: string;
	firstKeptEntryId: string;
	model: Model<string>;
	settings: CompactionSettings;
	preparation: CompactionPreparation;
	prefixIds: ReadonlySet<string>;
	controller: AbortController;
	outcome: Promise<BackgroundCompactionOutcome>;
}

/** Freeze completed history without consuming an unanswered input or splitting an outstanding tool batch. */
export function prepareBackgroundCompaction(
	manager: SessionManager,
	branch: SessionEntry[],
	model: Model<string>,
	settings: CompactionSettings,
	generate: (
		preparation: CompactionPreparation,
		model: Model<string>,
		controller: AbortController,
		checkpointId: string,
	) => Promise<BackgroundCompactionOutcome>,
): BackgroundCompaction | undefined {
	const projection = buildSessionProjection(branch);
	let end = 0;
	const pendingTools = new Set<string>();
	let completedToolBatch = false;
	for (let index = 0; index < projection.entries.length; index++) {
		for (const message of projection.entries[index].messages) {
			if (message.role === "assistant") {
				if (pendingTools.size > 0) return undefined;
				if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length") {
					break;
				}
				// The newest tool results stay verbatim until a successful assistant has consumed them.
				if (completedToolBatch) {
					end = index;
					completedToolBatch = false;
				}
				for (const block of message.content) {
					if (block.type === "toolCall") pendingTools.add(block.id);
				}
				if (pendingTools.size === 0) end = index + 1;
			} else if (message.role === "toolResult" && pendingTools.delete(message.toolCallId)) {
				if (pendingTools.size === 0) completedToolBatch = true;
			}
		}
	}
	if (end === 0) return undefined;

	const checkpointId = manager.appendCustomEntry(CONTEXT_CHECKPOINT_TYPE);
	const checkpoint = manager.getEntry(checkpointId)!;
	branch.push(checkpoint);
	const firstKeptEntryId = projection.entries[end]?.sourceEntry.id ?? checkpointId;
	const preparation = prepareCompaction(branch, settings, firstKeptEntryId);
	if (!preparation) return undefined;
	const controller = new AbortController();
	return {
		checkpointId,
		firstKeptEntryId,
		model,
		settings,
		preparation,
		prefixIds: new Set(projection.entries.slice(0, end).map((entry) => entry.sourceEntry.id)),
		controller,
		// Publish the snapshot in its owner before an extension hook can cancel or replace the session.
		outcome: Promise.resolve().then(() => generate(preparation, model, controller, checkpointId)),
	};
}

/** Reject a prepared summary after branching, editing its prefix, replacing context, or changing its policy/model. */
export function isBackgroundCompactionValid(
	prepared: BackgroundCompaction,
	branch: SessionEntry[],
	model: Model<string>,
	settings: CompactionSettings,
): boolean {
	if (
		prepared.controller.signal.aborted ||
		prepared.model.provider !== model.provider ||
		prepared.model.id !== model.id ||
		prepared.model.contextWindow !== model.contextWindow ||
		prepared.model.maxTokens !== model.maxTokens ||
		!settings.enabled ||
		prepared.settings.prepareThreshold !== settings.prepareThreshold ||
		prepared.settings.threshold !== settings.threshold ||
		prepared.settings.maxSummaryTokens !== settings.maxSummaryTokens ||
		prepared.settings.keepRecentTokens !== settings.keepRecentTokens
	)
		return false;
	const checkpointIndex = branch.findIndex((entry) => entry.id === prepared.checkpointId);
	if (checkpointIndex < 0) return false;
	for (let index = checkpointIndex + 1; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type === "compaction" || (entry.type === "context_edit" && prepared.prefixIds.has(entry.targetId))) {
			return false;
		}
	}
	return true;
}
