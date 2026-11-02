import { copyJson } from "@earendil-works/chord";
import { type Op, track } from "@earendil-works/chord/delta";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type ToolCall,
	ToolCallArgumentsStream,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { LiveState } from "../src/harness/live.ts";
import { PartialChanges, type PartialMessage } from "../src/harness/partial-changes.ts";

// #9265: partial commits reassigned the growing strings of a streamed answer, and Chord compared each one whole.

type Live = { generation: NonNullable<LiveState["generation"]> };

/**
 * A response streaming one text block (started empty) and then one tool call, as a provider produces it: the partial
 * message it mutates and the events it emits. Partial commits go into a tracked document, as Durable's generation does.
 */
function setup() {
	const partial: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: 0,
	};
	const changes = new PartialChanges();
	const tracker = track<Live>({ generation: { attempt: 1 } });
	const args = new ToolCallArgumentsStream();
	const emit = (event: AssistantMessageEvent) => changes.observe(event);
	const ops: Op[][] = [];
	return {
		partial,
		tracker,
		ops,
		text(delta: string) {
			(partial.content[0] as { text: string }).text += delta;
			emit({ type: "text_delta", contentIndex: 0, delta, partial });
		},
		argument(delta: string) {
			if (partial.content[1] === undefined) {
				partial.content.push({ type: "toolCall", id: "c1", name: "write", arguments: {} });
				emit({ type: "toolcall_start", contentIndex: 1, partial });
			}
			(partial.content[1] as { arguments: Record<string, unknown> }).arguments = args.append(delta);
			emit({ type: "toolcall_delta", contentIndex: 1, delta, partial });
		},
		/** The provider ends both blocks. */
		endBlocks() {
			emit({ type: "text_end", contentIndex: 0, content: (partial.content[0] as { text: string }).text, partial });
			emit({ type: "toolcall_end", contentIndex: 1, toolCall: partial.content[1] as ToolCall, partial });
		},
		/** One partial commit, as the generation's throttle makes it; `fail` aborts it like a rejected commit. */
		commit(fail = false) {
			// As the generation copies it: `copyJson()` returns untyped JSON, here a message's JSON representation.
			const message = copyJson(partial) as PartialMessage;
			const taken = changes.take(message);
			const change = tracker.beginChange();
			changes.commit(change.state.generation, message, taken);
			if (fail) {
				change.abort();
				changes.restore(taken);
				return;
			}
			const prepared = change.prepare();
			ops.push([...prepared.ops]);
			tracker.adopt(prepared);
		},
		committed() {
			const message = tracker.value.generation.message as { content: { text?: string; arguments?: unknown }[] };
			return { text: message.content[0]?.text, arguments: message.content[1]?.arguments };
		},
	};
}

function pieces(text: string, size: number): string[] {
	const result: string[] = [];
	for (let index = 0; index < text.length; index += size) result.push(text.slice(index, index + size));
	return result;
}

const ARGUMENTS = {
	path: "src/a.ts",
	n: 1234,
	ok: true,
	content: 'line "one"\n\tline \\ two é 😀\n',
	edits: [
		{ oldText: "a", newText: "b\nc" },
		{ oldText: "", newText: "x".repeat(50) },
	],
	nested: { deep: { list: [1, [2, "three"], { four: null }] } },
};

describe("PartialChanges", () => {
	it("commits tool-call arguments equal to the final parse, at every piece size and commit rhythm", () => {
		const text = JSON.stringify(ARGUMENTS);
		for (const size of [1, 2, 3, 5, 7, 16]) {
			for (const every of [1, 3, 10]) {
				const stream = setup();
				pieces(text, size).forEach((piece, index) => {
					stream.argument(piece);
					if (index % every === every - 1) stream.commit();
				});
				stream.commit();
				expect(stream.committed().arguments, `size ${size}, every ${every}`).toEqual(ARGUMENTS);
			}
		}
	});

	it("handles a number ending and a string starting in one piece, and escapes split across pieces", () => {
		const stream = setup();
		for (const piece of [
			'{"n":1',
			'2,"s":"a',
			"b\\",
			'u00e9\\"',
			"q\\u",
			"00",
			"41",
			'","t":tr',
			"ue,",
			'"u":"\\ud83d',
			'\\ude00"}',
		]) {
			stream.argument(piece);
			stream.commit();
		}
		expect(stream.committed().arguments).toEqual({ n: 12, s: 'abé"qA', t: true, u: "😀" });
	});

	it("appends growing argument and text strings instead of reassigning them", () => {
		const stream = setup();
		stream.text("Hello");
		stream.argument('{"path":"a.ts","content":"x');
		stream.commit();
		for (let index = 0; index < 20; index++) {
			stream.text(" more");
			stream.argument("yz");
			stream.commit();
		}
		for (const ops of stream.ops.slice(1)) {
			expect(ops).toEqual([
				["a", ["generation", "message", "content", 0, "text"], " more"],
				["a", ["generation", "message", "content", 1, "arguments", "content"], "yz"],
			]);
		}
		expect(stream.committed()).toEqual({
			text: `Hello${" more".repeat(20)}`,
			arguments: { path: "a.ts", content: `x${"yz".repeat(20)}` },
		});
	});

	it("applies the changes of a failed commit in the next one", () => {
		const stream = setup();
		stream.argument('{"a":"x');
		stream.commit();
		stream.argument('y","b":[1');
		stream.commit(true);
		stream.argument(',2],"c":"z"}');
		stream.commit();
		expect(stream.committed().arguments).toEqual({ a: "xy", b: [1, 2], c: "z" });
	});

	it("re-applies a failed commit's changes even when it would have added the call", () => {
		const stream = setup();
		stream.commit();
		stream.argument('{"a":"x');
		stream.commit(true);
		stream.argument('y"');
		stream.commit();
		expect(stream.committed().arguments).toEqual({ a: "xy" });
	});

	it("falls back to the snapshot when the committed message lost a call whose changes were committed", () => {
		const stream = setup();
		stream.argument('{"a":"x');
		stream.commit();
		// Another writer resets the generation's partial.
		const change = stream.tracker.beginChange();
		change.state.generation = { attempt: 1 };
		stream.tracker.adopt(change.prepare());
		stream.argument('y"');
		stream.commit();
		expect(stream.committed().arguments).toEqual({ a: "xy" });
		stream.argument(',"b":2}');
		stream.commit();
		expect(stream.committed().arguments).toEqual({ a: "xy", b: 2 });
	});

	it("commits the final arguments after the call ends, and drops text appends when a block ends", () => {
		const stream = setup();
		stream.text("draft");
		stream.argument('{"a":"x');
		stream.commit();
		// Providers may replace a block's text and arguments as it ends; the last commit assigns what they ended with.
		stream.text(" more");
		(stream.partial.content[0] as { text: string }).text = "replaced";
		stream.partial.content[1] = { type: "toolCall", id: "c1", name: "write", arguments: { a: "final" } };
		stream.endBlocks();
		stream.commit();
		expect(stream.committed()).toEqual({ text: "replaced", arguments: { a: "final" } });
	});
});
