import type { Message, ToolResultMessage } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";
import { ExtensionRunner } from "./runner.js";

function makeUserMessage(text: string): Message {
	return { role: "user", content: text, timestamp: Date.now() };
}

function makeToolResult(text: string): ToolResultMessage<unknown> {
	return {
		role: "toolResult",
		toolCallId: "tc_1",
		toolName: "bash",
		content: [{ type: "text", text }],
		details: { text },
		isError: false,
		timestamp: Date.now(),
	};
}

describe("ExtensionRunner", () => {
	it("applies context hooks by priority (desc), then registration order (asc)", async () => {
		const runner = new ExtensionRunner();
		const calls: string[] = [];

		runner.registerContext(
			(messages) => {
				calls.push("p0-a");
				return messages;
			},
			{ sourceId: "a", priority: 0 },
		);

		runner.registerContext(
			(messages) => {
				calls.push("p10-a");
				return messages;
			},
			{ sourceId: "b", priority: 10 },
		);

		runner.registerContext(
			(messages) => {
				calls.push("p10-b");
				return messages;
			},
			{ sourceId: "c", priority: 10 },
		);

		await runner.applyContext([makeUserMessage("hi")]);
		expect(calls).toEqual(["p10-a", "p10-b", "p0-a"]);
	});

	it("runs beforeToolCall hooks as a chain: patch updates args; block short-circuits", async () => {
		const runner = new ExtensionRunner();
		const calls: Array<{ name: string; args: unknown }> = [];

		runner.registerBeforeToolCall(
			(event) => {
				calls.push({ name: "patch", args: event.args });
				return { type: "patch", args: { a: 1 } };
			},
			{ sourceId: "a", priority: 0 },
		);

		runner.registerBeforeToolCall(
			(event) => {
				calls.push({ name: "block", args: event.args });
				return { type: "block", reason: "nope" };
			},
			{ sourceId: "b", priority: 0 },
		);

		runner.registerBeforeToolCall(
			(event) => {
				calls.push({ name: "never", args: event.args });
				return { type: "noop" };
			},
			{ sourceId: "c", priority: 0 },
		);

		const res = await runner.applyBeforeToolCall({ toolCallId: "tc_1", toolName: "bash", args: {} });
		expect(res.blocked).toBe(true);
		expect(res.reason).toBe("nope");
		expect(calls.map((c) => c.name)).toEqual(["patch", "block"]);
		// Second hook sees patched args.
		expect(calls[1]?.args).toEqual({ a: 1 });
	});

	it("applies afterToolResult hooks as a patch chain", () => {
		const runner = new ExtensionRunner();

		runner.registerAfterToolResult(
			(tr) => ({ ...tr, details: { ...(tr.details as Record<string, unknown>), a: 1 } }),
			{ sourceId: "a", priority: 0 },
		);
		runner.registerAfterToolResult(
			(tr) => ({ ...tr, details: { ...(tr.details as Record<string, unknown>), b: 2 } }),
			{ sourceId: "b", priority: 0 },
		);

		const result = runner.applyAfterToolResult(makeToolResult("ok"));
		expect(result.details).toEqual({ text: "ok", a: 1, b: 2 });
	});

	it("supports unregisterBySourceId across all hook kinds", async () => {
		const runner = new ExtensionRunner();

		runner.registerContext((m) => m.concat(makeUserMessage("extra")), { sourceId: "a", priority: 0 });
		runner.registerContext((m) => m.concat(makeUserMessage("extra2")), { sourceId: "b", priority: 0 });

		runner.unregisterBySourceId("a");
		const out = await runner.applyContext([makeUserMessage("hi")]);
		expect(out.map((m) => (typeof m.content === "string" ? m.content : ""))).toEqual(["hi", "extra2"]);
	});
});
