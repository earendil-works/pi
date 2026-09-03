import type { AssistantMessageFrame } from "@earendil-works/pi-ai";
import { describe, expect, expectTypeOf, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import type {
	DurableStructuralPreparation,
	JsonValue,
	LaneConfiguration,
	LaneState,
	OperationMeta,
	OperationResultRecord,
	OperationState,
	PendingEntry,
	SessionReader,
} from "../../src/harness/session/types.ts";
import {
	appendList,
	branchTip,
	branchTipInventoryPrefix,
	deleteList,
	deleteValue,
	entryLabel,
	type ListElement,
	laneConfig,
	laneState,
	list,
	operationMeta,
	operationPreparation,
	operationPreparationPrefix,
	operationResult,
	operationState,
	operationToolArgs,
	operationToolArgsPrefix,
	operationToolMemo,
	operationToolMemoPrefix,
	pendingAssistantFrames,
	pendingEntry,
	pendingToolOutput,
	pendingToolOutputPrefix,
	type StoredValue,
	sessionName,
	setValue,
	type Value,
	type ValueList,
	value,
} from "../../src/harness/session/values.ts";

describe("bound value addresses", () => {
	it("binds immutable scalar and list addresses with validated components", () => {
		expect(value<string>("app.state")).toEqual({ kind: "value", namespace: "app.state", key: "" });
		expect(list<number>("app.events", "workspace")).toEqual({
			kind: "list",
			namespace: "app.events",
			key: "workspace",
		});
		expect(Object.isFrozen(value<string>("app.state"))).toBe(true);
		expect(() => value<unknown>("")).toThrow("must not be empty");
		expect(() => value<unknown>("app\0state")).toThrow("must not contain");
		expect(() => list<unknown>("app.events", "bad\0key")).toThrow("must not contain");
		expect(value<unknown>("pi.application")).toEqual({ kind: "value", namespace: "pi.application", key: "" });
	});

	it("preserves invariant address and helper types", () => {
		const scalar = value<{ count: number }>("app.state");
		const events = list<{ name: string }>("app.events");
		expectTypeOf(scalar).toEqualTypeOf<Value<{ count: number }>>();
		expectTypeOf(events).toEqualTypeOf<ValueList<{ name: string }>>();
		expectTypeOf(setValue(scalar, { count: 1 }).value).toEqualTypeOf<unknown>();
		expectTypeOf(appendList(events, { name: "created" }).value).toEqualTypeOf<unknown>();

		const compileTimeFailures = () => {
			// @ts-expect-error Value is invariant in its stored type
			const widenedScalar: Value<unknown> = scalar;
			// @ts-expect-error ValueList is invariant in its element type
			const widenedList: ValueList<unknown> = events;
			// @ts-expect-error the bound scalar address controls the write type
			setValue(scalar, { count: "wrong" });
			// @ts-expect-error the bound list address controls the element type
			appendList(events, { name: 1 });
			// @ts-expect-error scalar helpers reject list addresses
			deleteValue(events);
			// @ts-expect-error list helpers reject scalar addresses
			deleteList(scalar);
			void widenedScalar;
			void widenedList;
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});

	it("infers list element types through Storage and SessionReader", async () => {
		const storage = new MemoryStorage({ now: () => 1 });
		const events = list<{ name: string }>("app.events");
		const reader: SessionReader = storage;
		const storageElements = await storage.readList(events, undefined, BACKGROUND_CONTEXT);
		const readerElements = await reader.readList(events, undefined, BACKGROUND_CONTEXT);
		expectTypeOf(storageElements).toEqualTypeOf<ListElement<{ name: string }>[]>();
		expectTypeOf(readerElements).toEqualTypeOf<ListElement<{ name: string }>[]>();
		await storage.close(BACKGROUND_CONTEXT);
	});

	it("uses separately constructed equal addresses for one durable location", async () => {
		const storage = new MemoryStorage({ now: () => 1 });
		const first = value<{ ready: boolean }>("app.state", "workspace");
		const second = value<{ ready: boolean }>("app.state", "workspace");
		await storage.commit([setValue(first, { ready: true })], BACKGROUND_CONTEXT);
		const stored = await storage.getValue(second, BACKGROUND_CONTEXT);
		expect(stored).toEqual({ address: first, value: { ready: true }, seq: 1 });
		expectTypeOf(stored).toEqualTypeOf<StoredValue<{ ready: boolean }> | undefined>();
		await storage.close(BACKGROUND_CONTEXT);
	});
});

describe("built-in durable addresses", () => {
	it("uses the exact reserved namespaces, keys, kinds, and value types", () => {
		const config = laneConfig("review");
		const meta = operationMeta("operation");
		const state = operationState("operation");
		const frames = pendingAssistantFrames("operation", "response");
		expectTypeOf(config).toEqualTypeOf<Value<LaneConfiguration>>();
		expectTypeOf(branchTip("review")).toEqualTypeOf<Value<string | null>>();
		expectTypeOf(laneState("review")).toEqualTypeOf<Value<LaneState>>();
		expectTypeOf(operationResult("operation")).toEqualTypeOf<Value<OperationResultRecord>>();
		expectTypeOf(meta).toEqualTypeOf<Value<OperationMeta>>();
		expectTypeOf(state).toEqualTypeOf<Value<OperationState>>();
		expectTypeOf(operationToolArgs("operation", "step", 2)).toEqualTypeOf<Value<Record<string, JsonValue>>>();
		expectTypeOf(operationToolMemo("operation", "invocation", "name")).toEqualTypeOf<Value<JsonValue>>();
		expectTypeOf(operationPreparation("operation", "task")).toEqualTypeOf<Value<DurableStructuralPreparation>>();
		expectTypeOf(pendingEntry("entry")).toEqualTypeOf<Value<PendingEntry>>();
		expectTypeOf(frames).toEqualTypeOf<ValueList<AssistantMessageFrame>>();

		expect([
			branchTip("review"),
			laneConfig("review"),
			laneState("review"),
			operationResult("operation"),
			meta,
			state,
			operationToolArgs("operation", "step", 2),
			operationToolMemo("operation", "invocation", "name"),
			operationPreparation("operation", "task"),
			pendingEntry("entry"),
			pendingToolOutput("operation", "invocation"),
			frames,
			sessionName,
			entryLabel("entry"),
		]).toEqual([
			{ kind: "value", namespace: "pi.branch.tip", key: "review" },
			{ kind: "value", namespace: "pi.lane.config", key: "review" },
			{ kind: "value", namespace: "pi.lane.state", key: "review" },
			{ kind: "value", namespace: "pi.result", key: "operation" },
			{ kind: "value", namespace: "pi.op.meta", key: "operation" },
			{ kind: "value", namespace: "pi.op.state", key: "operation" },
			{ kind: "value", namespace: "pi.op.tool_args", key: "operation:step:2" },
			{ kind: "value", namespace: "pi.op.tool_memo", key: "operation:invocation:name" },
			{ kind: "value", namespace: "pi.op.preparation", key: "operation:task" },
			{ kind: "value", namespace: "pi.pending.entry", key: "entry" },
			{ kind: "value", namespace: "pi.pending.tool_output", key: "operation:invocation" },
			{ kind: "list", namespace: "pi.pending.assistant_frame", key: "operation:response" },
			{ kind: "value", namespace: "pi.session.name", key: "" },
			{ kind: "value", namespace: "pi.entry.label", key: "entry" },
		]);
	});

	it("exports exactly the five documented scan-prefix constructors", () => {
		const prefixes = [
			branchTipInventoryPrefix(),
			operationToolArgsPrefix("operation"),
			operationToolMemoPrefix("operation", "invocation"),
			operationPreparationPrefix("operation"),
			pendingToolOutputPrefix("operation"),
		];
		expect(prefixes).toHaveLength(5);
		expect(prefixes).toEqual([
			{ kind: "value", namespace: "pi.branch.tip", key: "" },
			{ kind: "value", namespace: "pi.op.tool_args", key: "operation:" },
			{ kind: "value", namespace: "pi.op.tool_memo", key: "operation:invocation:" },
			{ kind: "value", namespace: "pi.op.preparation", key: "operation:" },
			{ kind: "value", namespace: "pi.pending.tool_output", key: "operation:" },
		]);
		expect(operationToolArgsPrefix("operation", "step").key).toBe("operation:step:");
		expect(operationToolMemoPrefix("operation").key).toBe("operation:");
	});
});
