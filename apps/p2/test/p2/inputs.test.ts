// People's inputs as structured entries: the transcript, queued inputs and tool attribution read authors from entry
// data; old sessions' pi.user entries go through the one legacy reader.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConversationView, EntryRecord, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import { legacyMessage, messageOf } from "../../src/runtime/input.ts";
import { originOf } from "../../src/runtime/origin.ts";
import { speakerText } from "../../src/runtime/speaker.ts";
import { buildTranscript } from "../../src/web/transcript.ts";
import { wholeView } from "../fixtures/whole-view.ts";

const OWNER = { kind: "owner", id: "owner", name: "Owner" } as const;
const ALICE = { kind: "guest", id: "alice", name: "Alice" } as const;
const user = (content: unknown) => [{ role: "user", content, timestamp: 0 }];
const entry = (fields: Record<string, unknown>) => ({ conversationId: 1, ...fields }) as unknown as EntryRecord;
const view = (entries: EntryRecord[], inbox: unknown[] = []) =>
	({ conversation: {}, entries, docs: { "pi.inbox": { items: inbox } } }) as unknown as ConversationView;

describe("structured inputs", () => {
	it("shows people's inputs, mentions and queued inputs from their data, never from the speaker block", () => {
		// The model message carries a speaker block naming someone else: the data decides.
		const typed = entry({
			id: 2,
			kind: "p2.input",
			data: { author: ALICE, text: "hello", attachments: [{ id: "u1", name: "plan.md" }] },
			model: user([
				{ type: "text", text: speakerText(OWNER) },
				{ type: "text", text: "hello\n\n<attachments>…" },
			]),
		});
		const mention = entry({
			id: 3,
			kind: "chat.mention",
			data: { author: OWNER, text: "@pi go", attachments: [], included: [1] },
			model: user([
				{ type: "text", text: speakerText(OWNER) },
				{ type: "text", text: "<chat>…</chat>" },
			]),
		});
		const queued = {
			id: 9,
			mode: "followUp",
			content: [{ type: "text", text: speakerText(OWNER) }],
			entry: { kind: "p2.input", data: { author: ALICE, text: "later", attachments: [] } },
		};
		const transcript = buildTranscript(wholeView(view([typed, mention], [queued])));
		const [first, second] = transcript.items;
		assert.deepEqual(first?.type === "user" && [first.author, first.text, first.files], [
			ALICE,
			"hello",
			["plan.md"],
		]);
		assert.deepEqual(second?.type === "user" && [second.author, second.text], [OWNER, "@pi go"]);
		assert.deepEqual(
			transcript.queued.map((item) => item.text),
			["later"],
		);
	});

	it("reads old sessions' pi.user entries through the one legacy reader", () => {
		const content = [
			{ type: "text", text: speakerText(ALICE) },
			{
				type: "text",
				text: "old\n\n<attachments>\nThe user attached these files:\n- /u/x-a.txt (a.txt, 3 bytes)\n</attachments>",
			},
		];
		assert.deepEqual(legacyMessage(content), {
			author: ALICE,
			text: "old",
			attachments: [{ id: "", name: "a.txt" }],
		});
		// Only for pi.user entries: other entries' data is read, their content is not.
		assert.equal(messageOf({ unrelated: true }), undefined);
		assert.deepEqual(messageOf({ unrelated: true }, content)?.author, ALICE);
		const [old] = buildTranscript(wholeView(view([entry({ id: 1, kind: "pi.user", model: user(content) })]))).items;
		assert.deepEqual(old?.type === "user" && [old.author, old.text, old.files], [ALICE, "old", ["a.txt"]]);
		// A marker inside the text is ordinary text.
		assert.equal(legacyMessage([{ type: "text", text: `hi ${speakerText(OWNER)}` }]), undefined);
	});

	it("attributes a tool call by the data of the input before it", async () => {
		const api = (entries: EntryRecord[]): ToolExecutionApi =>
			({
				conversationId: 1,
				taskId: "tool",
				getTask: async () => ({ kind: "pi.tool", input: { assistant: 10 } }),
				commit: async (change: (tx: Tx) => unknown) =>
					change({
						scanEntries: async (query: { maxEntryId: number }) => ({
							items: entries.filter((item) => item.id <= query.maxEntryId),
						}),
					} as unknown as Tx),
			}) as unknown as ToolExecutionApi;
		const input = (id: number, author: typeof OWNER | typeof ALICE, speaker = author) =>
			entry({
				id,
				kind: "p2.input",
				data: { author, text: "x", attachments: [] },
				model: user([{ type: "text", text: speakerText(speaker) }]),
			});
		const context = {} as never;
		assert.equal(await originOf(api([input(9, OWNER)]), context), "owner");
		// The speaker block claims the owner; the data says Alice. Data wins.
		assert.equal(await originOf(api([input(9, ALICE, OWNER)]), context), undefined);
		// A compaction summary after the owner's input is not an input: the owner's grant holds.
		const compaction = entry({ id: 9, kind: "pi.compaction", model: user("summary") });
		assert.equal(await originOf(api([compaction, input(8, OWNER)]), context), "owner");
	});

	it("attributes a nested call (a code mode script's tools.<name>()) by its model-issued call's turn", async () => {
		// Task 1 is the model-issued codemode call; 2 is a call its script made, 3 a call that call made.
		const tasks: Record<number, unknown> = {
			1: { kind: "pi.tool", input: { kind: "model", assistant: 10, callId: "c" } },
			2: { kind: "pi.tool", input: { kind: "nested", parent: 1, parentCallId: "c", key: "c1", call: {} } },
			3: { kind: "pi.tool", input: { kind: "nested", parent: 2, parentCallId: "c/c1", key: "c1", call: {} } },
			4: { kind: "pi.tool", input: { kind: "nested", parent: 99, parentCallId: "x", key: "c1", call: {} } },
			5: { kind: "pi.tool", input: { kind: "nested", parent: 5, parentCallId: "x", key: "c1", call: {} } },
		};
		const api = (taskId: number, author: typeof OWNER | typeof ALICE): ToolExecutionApi =>
			({
				conversationId: 1,
				taskId,
				getTask: async (id: number) => tasks[id],
				commit: async (change: (tx: Tx) => unknown) =>
					change({
						scanEntries: async () => ({
							items: [
								entry({
									id: 9,
									kind: "p2.input",
									data: { author, text: "x", attachments: [] },
									model: user([{ type: "text", text: speakerText(author) }]),
								}),
							],
						}),
					} as unknown as Tx),
			}) as unknown as ToolExecutionApi;
		const context = {} as never;
		assert.equal(await originOf(api(2, OWNER), context), "owner", "one level");
		assert.equal(await originOf(api(3, OWNER), context), "owner", "two levels");
		assert.equal(await originOf(api(3, ALICE), context), undefined, "a guest's turn stays denied");
		assert.equal(await originOf(api(4, OWNER), context), undefined, "a missing parent denies");
		assert.equal(await originOf(api(5, OWNER), context), undefined, "a cycle denies");
	});
});
