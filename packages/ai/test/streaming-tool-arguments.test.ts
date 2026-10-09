import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, ToolCall } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { parseStreamingJson } from "../src/utils/json-parse.ts";
import { createPendingToolCall } from "../src/utils/pending-tool-call.ts";

function toolCall(): ToolCall {
	return { type: "toolCall", id: "call_test", name: "write", arguments: {} };
}

afterEach(() => vi.restoreAllMocks());

// Regression coverage for #9265: delta-only consumers must not parse growing prefixes.
describe("pending tool calls", () => {
	it("parses a large streamed argument only when read and caches the result", () => {
		const pending = createPendingToolCall(toolCall());
		const block = pending.toolCall;
		const parse = vi.spyOn(JSON, "parse");
		let json = '{"content":"';
		for (let i = 0; i < 128; i++) {
			json += "a".repeat(8192);
			pending.setJson(json);
		}
		json += '"}';
		pending.setJson(json);
		expect(parse).not.toHaveBeenCalled();

		const args = block.arguments;
		expect(args.content).toHaveLength(1024 * 1024);
		expect(block.arguments).toBe(args);
		expect(parse).toHaveBeenCalledExactlyOnceWith(json);
		pending.finish();
		expect(pending.toolCall).toBe(block);
		expect(parse).toHaveBeenCalledExactlyOnceWith(json);
		expect(Object.getOwnPropertyDescriptor(block, "arguments")).toEqual({
			value: args,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	});

	it.each([
		undefined,
		"",
		"not json",
		"null",
		"false",
		"0",
		'""',
		'{"path":"a.txt","content":"hel',
		'{"nested":{"items":[1,true,{"value":"par',
		'{"content":"line1\nline2',
		String.raw`{"path":"A\H","content":"\uD83D`,
	])("preserves best-effort parsing for %j", (json) => {
		const pending = createPendingToolCall(toolCall());
		const expected = parseStreamingJson(json);
		pending.setJson(json);
		expect(pending.toolCall.arguments).toEqual(expected);
	});

	it("invalidates on the next delta without mutating previously read arguments", () => {
		const pending = createPendingToolCall(toolCall());
		pending.setJson('{"content":"hel');
		const first = pending.toolCall.arguments;
		expect(first).toEqual({ content: "hel" });
		pending.setJson('{"content":"hello"}');
		expect(pending.toolCall.arguments).toEqual({ content: "hello" });
		expect(first).toEqual({ content: "hel" });
		expect(pending.toolCall.arguments).not.toBe(first);
	});

	it("accepts authoritative assignments without parsing the discarded prefix", () => {
		const pending = createPendingToolCall(toolCall());
		const block = pending.toolCall;
		const parse = vi.spyOn(JSON, "parse");
		pending.setJson('{"content":"discarded');
		const authoritative = { content: "replacement" };
		Object.assign(block, { arguments: authoritative, namespace: "tools" });
		pending.finish();
		expect(block.arguments).toBe(authoritative);
		expect(block.namespace).toBe("tools");
		expect(parse).not.toHaveBeenCalled();
		expect(Object.getOwnPropertyDescriptor(block, "arguments")?.get).toBeUndefined();
	});

	it("keeps interleaved calls independent", () => {
		const first = createPendingToolCall(toolCall());
		const second = createPendingToolCall(toolCall());
		first.setJson('{"content":"one');
		second.setJson('{"content":"two');
		expect(second.toolCall.arguments).toEqual({ content: "two" });
		first.setJson('{"content":"one more"}');
		expect(first.toolCall.arguments).toEqual({ content: "one more" });
		expect(second.toolCall.arguments).toEqual({ content: "two" });
	});

	it("supports serialization, spreading, and structured cloning during streaming", () => {
		const pending = createPendingToolCall(toolCall());
		const block = pending.toolCall;
		pending.setJson('{"content":"partial');
		expect(JSON.parse(JSON.stringify(block)).arguments).toEqual({ content: "partial" });
		pending.setJson('{"content":"updated');
		expect({ ...block }.arguments).toEqual({ content: "updated" });
		pending.setJson('{"content":"cloned');
		expect(structuredClone(block).arguments).toEqual({ content: "cloned" });
	});

	it("shares a cached parse between proxy copies but keeps updates and assignments independent", () => {
		const pending = createPendingToolCall(toolCall());
		pending.setJson('{"content":"copied"}');
		const parse = vi.spyOn(JSON, "parse");
		const copy = pending.copy();
		expect(parse).not.toHaveBeenCalled();
		expect(copy.toolCall).not.toBe(pending.toolCall);
		expect(copy.toolCall.arguments).toEqual({ content: "copied" });
		expect(pending.toolCall.arguments).toBe(copy.toolCall.arguments);
		expect(parse).toHaveBeenCalledTimes(1);
		const replacement = { content: "authoritative" };
		copy.toolCall.arguments = replacement;
		expect(copy.toolCall.arguments).toBe(replacement);
		expect(pending.toolCall.arguments).toEqual({ content: "copied" });
		copy.setJson('{"content":"next"}');
		expect(copy.toolCall.arguments).toEqual({ content: "next" });
		expect(pending.toolCall.arguments).toEqual({ content: "copied" });
	});

	it("copies enumerable metadata, including symbols, with the proxy's original spread semantics", () => {
		const pending = createPendingToolCall(toolCall());
		pending.setJson('{"content":"unread');
		const symbol = Symbol("metadata");
		const metadata = { tag: "extension" };
		Object.assign(pending.toolCall, { extra: metadata, [symbol]: metadata });
		const getter = vi.fn(() => "computed");
		Object.defineProperty(pending.toolCall, "computed", { enumerable: true, get: getter });
		Object.defineProperty(pending.toolCall, "hidden", { value: "private" });
		const parse = vi.spyOn(JSON, "parse");
		const copy = pending.copy().toolCall;
		expect(parse).not.toHaveBeenCalled();
		expect(Reflect.get(copy, "extra")).toBe(metadata);
		expect(Reflect.get(copy, symbol)).toBe(metadata);
		expect(Object.getOwnPropertyDescriptor(copy, "computed")).toMatchObject({ value: "computed", writable: true });
		expect(getter).toHaveBeenCalledTimes(1);
		expect(getter.mock.contexts[0]).toBe(pending.toolCall);
		expect(copy).not.toHaveProperty("hidden");
	});

	it.each(["toolUse", "error", "aborted"] as const)(
		"lets the provider materialize unread arguments before %s settlement",
		async (reason) => {
			const pending = createPendingToolCall(toolCall());
			const block = pending.toolCall;
			pending.setJson('{"content":"interrupted');
			// #9265: the event stream must not inspect unrelated custom-provider getters.
			const foreign = toolCall();
			const foreignGetter = vi.fn(() => {
				throw new Error("Custom provider getter must not be read");
			});
			Object.defineProperty(foreign, "arguments", { get: foreignGetter });
			const message: AssistantMessage = {
				role: "assistant",
				content: [block, foreign],
				api: "openai-completions",
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
				stopReason: reason,
				timestamp: 0,
			};
			const stream = new AssistantMessageEventStream();
			pending.finish();
			stream.push(
				reason === "toolUse" ? { type: "done", reason, message } : { type: "error", reason, error: message },
			);
			expect(Object.getOwnPropertyDescriptor(block, "arguments")).toMatchObject({
				value: { content: "interrupted" },
				writable: true,
			});
			expect(await stream.result()).toBe(message);
			expect(foreignGetter).not.toHaveBeenCalled();
			expect(Object.getOwnPropertyDescriptor(foreign, "arguments")?.get).toBe(foreignGetter);
		},
	);
});
