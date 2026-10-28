// What a streamed answer changed in its partial message between two partial commits, so a commit costs the new text.
import type { JsonRepresentation, JsonValue } from "@earendil-works/chord";
import { appendText, type Draft } from "@earendil-works/chord/delta";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import { type JsonChange, StreamingJsonParser } from "@earendil-works/pi-ai/utils/streaming-json";
import { type AssignPlan, assignJson } from "./json.ts";
import type { LiveState } from "./live.ts";

type JsonContainer = Record<string, JsonValue> | JsonValue[];

/** A partial message as `pi.live.generation.message` holds it. */
export type PartialMessage = JsonRepresentation<AssistantMessage>;

/** Committed arguments of a streamed tool call. */
type Arguments = JsonRepresentation<ToolCall>["arguments"];

/** What one partial commit writes besides the partial message itself; from `PartialChanges.take()`. */
export type PartialCommit = {
	/** The plan `assignJson()` writes the message with: text appends, and the arguments it leaves to `changes`. */
	readonly plan: AssignPlan;
	/** Each tracked tool call by content index: its argument changes since the last commit, in order, and its snapshot. */
	readonly toolCalls: ReadonlyMap<number, { readonly changes: readonly JsonChange[]; readonly snapshot: Arguments }>;
};

/** What a tracked tool call changed since the last commit, and whether any commit took its changes yet. */
type ToolCallState = { readonly parser: StreamingJsonParser; changes: JsonChange[]; committed: boolean };

/**
 * Collects, from a response's events, what changed in its partial message since the last commit, so the commit appends
 * new text instead of reassigning growing strings. Reassigning makes Chord compare the old and new string, which costs
 * O(length) per commit.
 *
 * - Text and thinking: the `text_delta` and `thinking_delta` events. The commit appends them where the committed string
 *   plus the deltas has the new string's length, and compares otherwise. A block's `*_end` event drops them, because
 *   providers may replace the text when a block ends.
 * - Tool-call arguments: a `StreamingJsonParser` per call, fed with the raw argument text of each `toolcall_delta`,
 *   reports what each piece changed. The commit applies those changes to the committed arguments in order and leaves
 *   the arguments out of the message assignment, so the committed arguments are exactly the parsed text so far.
 *   `toolcall_end` ends the tracking; the call's last commit assigns its final arguments.
 */
export class PartialChanges {
	#text = new Map<number, { readonly field: "text" | "thinking"; text: string }>();
	readonly #toolCalls = new Map<number, ToolCallState>();

	/** Record what `event` changed. */
	observe(event: AssistantMessageEvent): void {
		switch (event.type) {
			case "text_delta":
			case "thinking_delta": {
				const field = event.type === "text_delta" ? "text" : "thinking";
				const pending = this.#text.get(event.contentIndex);
				if (pending?.field === field) pending.text += event.delta;
				else this.#text.set(event.contentIndex, { field, text: event.delta });
				return;
			}
			case "toolcall_start":
				this.#toolCalls.set(event.contentIndex, {
					parser: new StreamingJsonParser(),
					changes: [],
					committed: false,
				});
				return;
			case "toolcall_delta": {
				const call = this.#toolCalls.get(event.contentIndex);
				if (call === undefined) return;
				for (const change of call.parser.append(event.delta)) {
					// Arguments are an object: any other root shows as no arguments, so the snapshot is committed instead.
					if (change.path.length === 0 && !isRecord(change.kind === "set" ? value(change) : null)) {
						this.#toolCalls.delete(event.contentIndex);
						return;
					}
					call.changes.push(change);
				}
				return;
			}
			case "text_end":
			case "thinking_end":
				this.#text.delete(event.contentIndex);
				return;
			case "toolcall_end":
				this.#toolCalls.delete(event.contentIndex);
				return;
		}
	}

	/**
	 * Take what changed since the last call, for a commit of `message`, a copy of the partial. Clears the arguments of
	 * tracked tool calls in `message`: the commit writes them from the changes. Call `restore()` if the commit fails.
	 */
	take(message: PartialMessage): PartialCommit {
		const blocks = new Map<string | number, AssignPlan>();
		for (const [index, { field, text }] of this.#text) {
			blocks.set(index, { kind: "fields", fields: new Map([[field, { kind: "append", text }]]) });
		}
		this.#text = new Map();
		const toolCalls = new Map<number, { readonly changes: readonly JsonChange[]; readonly snapshot: Arguments }>();
		for (const [index, call] of this.#toolCalls) {
			const block = message.content[index];
			// A tracked call is the tool call its `toolcall_start` named; the narrowing only tells TypeScript.
			if (block?.type !== "toolCall") continue;
			toolCalls.set(index, { changes: call.changes, snapshot: block.arguments });
			block.arguments = {};
			blocks.set(index, { kind: "fields", fields: new Map([["arguments", { kind: "keep" }]]) });
			call.changes = [];
		}
		return {
			plan: { kind: "fields", fields: new Map([["content", { kind: "fields", fields: blocks }]]) },
			toolCalls,
		};
	}

	/**
	 * Write `message` with what `commit` took into `generation.message`: the message leaf by leaf with the plan, then the
	 * argument changes. A tracked call whose block is new here gets its arguments from its changes, which then start at
	 * its first piece; when the committed message lost a call whose changes were already committed (another writer reset
	 * it), the call falls back to its snapshot from now on.
	 */
	commit(
		generation: Draft<NonNullable<LiveState["generation"]>>,
		message: PartialMessage,
		commit: PartialCommit,
	): void {
		const committedBlocks = generation.message?.content.length ?? 0;
		const apply: [number, readonly JsonChange[]][] = [];
		for (const [index, { changes, snapshot }] of commit.toolCalls) {
			const call = this.#toolCalls.get(index);
			if (call === undefined) continue;
			const block = message.content[index];
			if (index >= committedBlocks && call.committed && block?.type === "toolCall") {
				// The earlier changes are not in the committed message: commit the snapshot and stop tracking the call.
				this.#toolCalls.delete(index);
				block.arguments = snapshot;
				continue;
			}
			call.committed = true;
			apply.push([index, changes]);
		}
		assignJson(generation, "message", message, commit.plan);
		const content = generation.message?.content ?? [];
		for (const [index, changes] of apply) {
			const block = content[index];
			if (block?.type !== "toolCall") continue;
			for (const change of changes) applyChange(block, change);
		}
	}

	/** Put back what a failed commit took, so the next commit applies it first. */
	restore(commit: PartialCommit): void {
		for (const [index, { changes }] of commit.toolCalls) {
			const call = this.#toolCalls.get(index);
			if (call !== undefined) call.changes = [...changes, ...call.changes];
		}
	}
}

/** Apply one argument change to the committed arguments of `block`. */
function applyChange(block: Draft<JsonRepresentation<ToolCall>>, change: JsonChange): void {
	const key = change.path.at(-1);
	if (key === undefined) {
		// Only an object root is tracked (`observe()` drops any other), and only `set` starts it.
		const root = change.kind === "set" ? value(change) : undefined;
		if (isRecord(root)) block.arguments = root;
		return;
	}
	// The path follows the parsed argument text, not a type: each segment names a container `observe()` saw set.
	let parent = block.arguments as Draft<JsonContainer>;
	for (const segment of change.path.slice(0, -1)) {
		parent = (parent as Record<string | number, Draft<JsonContainer>>)[segment]!;
	}
	const slots = parent as Record<string | number, JsonValue>;
	if (change.kind === "set") slots[key] = value(change);
	// appendText() takes object members; a string in an array is reassigned, which compares it whole.
	else if (Array.isArray(parent)) slots[key] = `${slots[key] as string}${change.text}`;
	else appendText(parent as Draft<Record<string, string>>, String(key), change.text);
}

/** The value a `set` change reports: JSON data, which pi-ai types with read-only arrays. */
function value(change: Extract<JsonChange, { kind: "set" }>): JsonValue {
	return change.value as JsonValue;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
