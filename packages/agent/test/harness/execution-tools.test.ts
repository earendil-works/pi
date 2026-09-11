import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { AbortRequested, createGate, type Gate } from "../../src/harness/execution/effect-gate.ts";
import {
	applyBeforeToolDecision,
	createToolResultMessage,
	executeToolCall,
	finalizeToolCall,
	prepareToolCall,
} from "../../src/harness/execution/tools.ts";
import type { AgentHarnessTool } from "../../src/harness/types.ts";
import type { AgentToolCall, AgentToolResult } from "../../src/types.ts";

const parameters = Type.Object({ value: Type.String() });

function call(arguments_: Record<string, unknown> = { value: "input" }): AgentToolCall {
	return { type: "toolCall", id: "call-1", name: "echo", arguments: arguments_ };
}

function tool(
	overrides: Partial<AgentHarnessTool<undefined, typeof parameters, { value: string }>> = {},
): AgentHarnessTool<undefined, typeof parameters, { value: string }> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo input",
		parameters,
		async execute(_toolCallId, args) {
			return {
				content: [{ type: "text", text: args.value }],
				details: { value: args.value },
			};
		},
		...overrides,
	};
}

function text(result: AgentToolResult<unknown>): string {
	return result.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("\n");
}

function isImmediate(
	result: ReturnType<typeof prepareToolCall> | ReturnType<typeof applyBeforeToolDecision>,
): result is Extract<ReturnType<typeof prepareToolCall>, { kind: "immediate" }> {
	return "kind" in result;
}

function clearPrepared(callToClear: ReturnType<typeof prepareToolCall>) {
	if (isImmediate(callToClear)) throw new Error("expected prepared call");
	const cleared = applyBeforeToolDecision(callToClear, undefined);
	if (isImmediate(cleared)) throw new Error("expected cleared call");
	return cleared;
}

function effectGate(): Gate {
	return createGate().gate;
}

const invocation = {
	invocationId: "result-1",
	operationId: "operation-1",
	turnId: "turn-1",
	getMemo: async () => undefined,
	setMemo: async () => {},
};

describe("tool execution primitives", () => {
	it("prepares arguments before validation and preserves the provider call", () => {
		const providerCall = call({ legacy: "prepared" });
		const prepared = prepareToolCall(providerCall, [
			tool({
				prepareArguments(args) {
					return { value: (args as { legacy: string }).legacy };
				},
			}),
		]);

		expect(isImmediate(prepared)).toBe(false);
		if (isImmediate(prepared)) return;
		expect(prepared.toolCall).toBe(providerCall);
		expect(prepared.args).toEqual({ value: "prepared" });
		expect(providerCall.arguments).toEqual({ legacy: "prepared" });
	});

	it("returns immediate errors for unknown tools, preparation throws, and invalid arguments", () => {
		const unknown = prepareToolCall(call(), []);
		const preparationFailure = prepareToolCall(call(), [
			tool({
				prepareArguments() {
					throw new Error("cannot prepare");
				},
			}),
		]);
		const invalid = prepareToolCall(call({}), [tool()]);

		expect(isImmediate(unknown) ? text(unknown.result) : "").toBe('Tool "echo" is unavailable');
		expect(isImmediate(unknown) ? unknown.result.details : null).toBeUndefined();
		expect(isImmediate(preparationFailure) ? text(preparationFailure.result) : "").toBe("cannot prepare");
		expect(isImmediate(invalid) ? text(invalid.result) : "").toContain('Validation failed for tool "echo"');
	});

	it("blocks calls and revalidates replacement arguments", () => {
		const prepared = prepareToolCall(call(), [tool()]);
		if (isImmediate(prepared)) throw new Error("expected prepared call");

		const blocked = applyBeforeToolDecision(prepared, {
			block: { reason: "denied", terminate: true },
		});
		const replaced = applyBeforeToolDecision(prepared, { args: { value: "replacement" } });
		const invalid = applyBeforeToolDecision(prepared, { args: {} });

		expect(blocked).toMatchObject({ kind: "immediate", isError: true, terminate: true });
		expect(isImmediate(blocked) ? text(blocked.result) : "").toBe("denied");
		expect(isImmediate(replaced) ? undefined : replaced.args).toEqual({ value: "replacement" });
		expect(isImmediate(invalid)).toBe(true);
	});

	it("executes with updates, passes the signal, and ignores late updates", async () => {
		const gate = effectGate();
		let lateUpdate: ((partial: AgentToolResult<{ value: string }>) => void) | undefined;
		const execute: AgentHarnessTool<undefined, typeof parameters, { value: string }>["execute"] = vi.fn(
			async (_id, args, onUpdate, _toolContext, _invocation, context) => {
				expect(context.abortSignal).toBe(gate.signal);
				onUpdate?.({ content: [{ type: "text", text: "partial" }], details: { value: args.value } });
				lateUpdate = onUpdate;
				return { content: [{ type: "text" as const, text: "done" }], details: { value: args.value } };
			},
		);
		const cleared = clearPrepared(prepareToolCall(call(), [tool({ execute })]));
		const updates: AgentToolResult<unknown>[] = [];

		const result = await executeToolCall(
			cleared,
			gate,
			(update) => updates.push(update),
			undefined,
			invocation,
			BACKGROUND_CONTEXT,
		);
		lateUpdate?.({ content: [{ type: "text", text: "late" }], details: { value: "late" } });

		expect(vi.mocked(execute)).toHaveBeenCalledOnce();
		expect(result.isError).toBe(false);
		expect(text(result.result)).toBe("done");
		expect(updates).toHaveLength(1);
		expect(text(updates[0])).toBe("partial");
	});

	it.each([
		[
			"synchronous",
			() => {
				throw new Error("tool failed");
			},
		],
		[
			"asynchronous",
			async () => {
				throw new Error("tool failed");
			},
		],
	])("converts %s tool throws to error output", async (_kind, execute) => {
		const cleared = clearPrepared(prepareToolCall(call(), [tool({ execute })]));

		const result = await executeToolCall(cleared, effectGate(), () => {}, undefined, invocation, BACKGROUND_CONTEXT);

		expect(result.isError).toBe(true);
		expect(text(result.result)).toBe("tool failed");
	});

	it("lets abort-first gate refusal escape without invoking the tool", async () => {
		const execute = vi.fn(tool().execute);
		const cleared = clearPrepared(prepareToolCall(call(), [tool({ execute })]));
		const { gate, control } = createGate();
		control.beginAbort(Promise.resolve());

		expect(() => executeToolCall(cleared, gate, () => {}, undefined, invocation, BACKGROUND_CONTEXT)).toThrow(
			AbortRequested,
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("applies patches field by field and constructs the tool-result message", () => {
		const cleared = clearPrepared(prepareToolCall(call(), [tool()]));
		const originalUsage = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const replacementUsage = { ...originalUsage, input: 5, totalTokens: 7 };
		const executed: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "original" }],
			details: { original: true },
			usage: originalUsage,
			addedToolNames: ["new-tool"],
		};

		const finalized = finalizeToolCall(
			cleared,
			{ result: executed, isError: true },
			{
				content: [{ type: "text", text: "patched" }],
				details: { patched: true },
				usage: replacementUsage,
				isError: false,
				terminate: true,
			},
		);
		const before = Date.now();
		const message = createToolResultMessage(finalized);

		expect(finalized).toMatchObject({ isError: false, terminate: true });
		expect(finalized.result).toMatchObject({
			content: [{ type: "text", text: "patched" }],
			details: { patched: true },
			usage: replacementUsage,
			addedToolNames: ["new-tool"],
			terminate: true,
		});
		expect(message).toMatchObject({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "echo",
			content: [{ type: "text", text: "patched" }],
			details: { patched: true },
			usage: replacementUsage,
			addedToolNames: ["new-tool"],
			isError: false,
		});
		expect(message.timestamp).toBeGreaterThanOrEqual(before);
	});

	it("normalizes missing content from untyped tools", () => {
		const cleared = clearPrepared(prepareToolCall(call(), [tool()]));
		const finalized = finalizeToolCall(
			cleared,
			{ result: { content: undefined, details: {} } as never, isError: false },
			undefined,
		);

		expect(createToolResultMessage(finalized).content).toEqual([]);
	});
});
