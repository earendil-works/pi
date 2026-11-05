// Who started a tool's turn (worker): tools with `origin: "owner"` (`tool-access.ts`) and agents writing into another
// conversation (subagent tasks and reports, `team`, peer messages, one-shot agents) read it.
import type { Context } from "@earendil-works/chord/context";
import {
	type ConversationId,
	type EntryId,
	type EntryRecord,
	LiveDoc,
	type ToolExecutionApi,
	type Tx,
} from "@earendil-works/pi-durable";
import type { ConversationOrigin } from "./entries.ts";
import { messageData } from "./input.ts";

/**
 * Who started the calling tool's turn: the owner, or nobody allowed (undefined). The turn is the conversation's current
 * run, a code mode script's nested calls included: it is the owner's only if every input the run placed so far is
 * (`entryOrigin`). A guest's message steered into the run takes it away for the rest of the run.
 */
export async function originOf(api: ToolExecutionApi, context: Context): Promise<ConversationOrigin | undefined> {
	const inputs = (await api.snapshot(LiveDoc, api.conversationId, context))?.run?.inputs ?? [];
	if (inputs.length === 0) return undefined;
	return api.commit(async (tx) => {
		let placed = 0;
		for (const id of inputs) {
			const submission = await tx.submission(id);
			// A continue places no entry: it adds no input, and only inputs grant.
			if (submission?.type === "continue") continue;
			const entry = submission?.entry === undefined ? undefined : await tx.entry(submission.entry);
			if (entryOrigin(entry) !== "owner") return undefined;
			placed++;
		}
		return placed > 0 ? "owner" : undefined;
	}, context);
}

/**
 * The origin an input entry records in its data: a person's input is the owner's when its author is the owner; what an
 * agent wrote (a subagent's task or report, a `team` or peer message, a one-shot agent's task) says `origin: "owner"`
 * when the turn that wrote it was the owner's. Anything else, a tool's plain input included, grants nothing.
 */
export function entryOrigin(entry: EntryRecord | undefined): ConversationOrigin | undefined {
	const person = messageData(entry?.data);
	if (person) return person.author.kind === "owner" && person.author.id === "owner" ? "owner" : undefined;
	const data = entry?.data;
	return data && typeof data === "object" && !Array.isArray(data) && data.origin === "owner" ? "owner" : undefined;
}

/**
 * The origin of the run that ended with the answer `answer` of `conversationId`, read after it ended (a subagent's
 * report, when `pi.live.run` is gone): its inputs are the input entries after the previous run's final answer. The
 * owner's only if all are. Only a final answer (`stop`, `length`) bounds the scan: a retried model error appends an
 * `error` answer and an overflow compaction a head marker inside a run, and scanning past a failed or aborted run only
 * adds inputs, so the result can only be stricter. (An `onYield` continuation after a final answer would hide the
 * inputs before it; p2 installs no such hook.)
 */
export async function answerOrigin(
	tx: Tx,
	conversationId: ConversationId,
	answer: EntryId,
): Promise<ConversationOrigin | undefined> {
	let found = false;
	let cursor: Parameters<Tx["scanEntries"]>[2];
	for (;;) {
		const page = await tx.scanEntries({ conversationId, maxEntryId: (answer - 1) as EntryId }, 100, cursor);
		for (const entry of page.items) {
			const message = entry.model?.[0];
			if (message?.role === "assistant" && (message.stopReason === "stop" || message.stopReason === "length"))
				return found ? "owner" : undefined;
			// Durable's own entries with user messages (compaction summaries, handoffs) are not inputs.
			if (message?.role !== "user" || (entry.kind.startsWith("pi.") && entry.kind !== "pi.user")) continue;
			if (entryOrigin(entry) !== "owner") return undefined;
			found = true;
		}
		if (!page.next) return found ? "owner" : undefined;
		cursor = page.next;
	}
}
