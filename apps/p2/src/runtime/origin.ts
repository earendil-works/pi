// Who started a tool's turn (worker): owner-only and peer-aware tools (locations, ports, dev-tools, subagents)
// check it.
import type { Context } from "@earendil-works/chord/context";
import type { Cursor, EntryId, ToolExecutionApi } from "@earendil-works/pi-durable";
import { CONVERSATION_PREFIX, type ConversationOrigin, SUBAGENT_TASK_ENTRY } from "./entries.ts";
import { messageOf } from "./input.ts";

/** Nested calls followed up to the model-issued call; deeper chains are refused. */
const MAX_NESTING = 32;

/**
 * Who started the calling tool's turn: the owner, an authenticated peer, or nobody allowed (undefined). Attribution is
 * fixed at the calling assistant entry, not a newer/racing browser input; only the first block counts. A call a
 * running tool made (code mode's `tools.<name>()`) is a nested tool task without an assistant entry: its `parent`
 * chain leads to the model-issued call, whose turn it inherits. Missing or malformed tasks, and cycles, deny.
 */
export async function originOf(api: ToolExecutionApi, context: Context): Promise<ConversationOrigin | undefined> {
	let taskId = api.taskId;
	let at: EntryId | undefined;
	for (let depth = 0; depth <= MAX_NESTING && at === undefined; depth++) {
		const task = await api.getTask(taskId, context);
		const input = task?.input;
		if (task?.kind !== "pi.tool" || !input || typeof input !== "object" || Array.isArray(input)) return undefined;
		if (input.kind === "nested") {
			if (typeof input.parent !== "number" || !Number.isSafeInteger(input.parent)) return undefined;
			taskId = input.parent as typeof taskId;
		} else if (typeof input.assistant === "number" && Number.isSafeInteger(input.assistant))
			at = input.assistant as EntryId;
		else return undefined;
	}
	if (at === undefined) return undefined;
	const turn = at;
	return api.commit(async (tx) => {
		let cursor: Cursor | undefined;
		for (let scanned = 0; scanned < 2000; ) {
			const page = await tx.scanEntries({ conversationId: api.conversationId, maxEntryId: turn }, 100, cursor);
			for (const entry of page.items) {
				scanned++;
				// The latest input before the calling answer, of any kind (p2.input, chat.mention, a tool's pi.user);
				// Durable's own entries with user messages (compaction summaries, handoffs) are not inputs.
				if (entry.kind.startsWith("pi.") && entry.kind !== "pi.user") continue;
				const message = entry.model?.find((message) => message.role === "user");
				if (!message) continue;
				// A main agent's message to its subagent carries the main turn's attribution, written by the worker.
				if (entry.kind === SUBAGENT_TASK_ENTRY) {
					const data = entry.data;
					return data && typeof data === "object" && !Array.isArray(data) && data.origin === "owner"
						? "owner"
						: undefined;
				}
				// A person's input: its author is in the data the worker wrote.
				const person = messageOf(entry.data, entry.kind === "pi.user" ? message.content : undefined);
				if (person) return person.author.kind === "owner" && person.author.id === "owner" ? "owner" : undefined;
				const header = Array.isArray(message.content) ? message.content[0] : undefined;
				if (header?.type !== "text") return undefined;
				try {
					if (header.text.startsWith(CONVERSATION_PREFIX) && header.text.endsWith("</mobile-conversation>")) {
						const sender: unknown = JSON.parse(
							header.text.slice(CONVERSATION_PREFIX.length, -"</mobile-conversation>".length),
						);
						return sender &&
							typeof sender === "object" &&
							"id" in sender &&
							typeof sender.id === "string" &&
							"title" in sender &&
							typeof sender.title === "string"
							? "peer"
							: undefined;
					}
				} catch {
					return undefined;
				}
				// Unattributed input (including a subagent report) cannot inherit an earlier owner's grant.
				return undefined;
			}
			if (!page.next) break;
			cursor = page.next;
		}
		return undefined;
	}, context);
}
