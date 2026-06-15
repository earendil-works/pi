import { beforeEach, describe, expect, it } from "vitest";
import { registerTools, validateItems } from "../tools.ts";
import type { TodoItem } from "../tools.ts";

function makeItems(...statuses: Array<TodoItem["status"]>): TodoItem[] {
	return statuses.map((status, i) => ({
		id: String(i + 1),
		content: `task ${i + 1}`,
		status,
	}));
}

describe("validateItems — same-state re-send (bug 1)", () => {
	it("full list re-send with all items unchanged returns null", () => {
		const items = makeItems("pending", "pending", "pending", "pending", "pending");
		expect(validateItems(items)).toBeNull();
		expect(validateItems(items, items)).toBeNull();
	});

	it("same-state items mixed with one real transition returns null", () => {
		const before = makeItems("pending", "pending", "pending", "pending", "pending");
		expect(validateItems(before)).toBeNull();
		const after = makeItems("pending", "pending", "pending", "pending", "in_progress");
		expect(validateItems(after, before)).toBeNull();
	});
});

describe("validateItems — MAX_IN_PROGRESS (bug 2)", () => {
	it("rejects 4 items in_progress", () => {
		const items = makeItems("in_progress", "in_progress", "in_progress", "in_progress");
		const error = validateItems(items);
		expect(error).not.toBeNull();
		expect(error).toMatch(/3/);
	});

	it("accepts exactly 3 items in_progress", () => {
		const items = makeItems("in_progress", "in_progress", "in_progress");
		expect(validateItems(items)).toBeNull();
	});
});

describe("validateItems — transition rules (existing behavior preserved)", () => {
	it("pending → in_progress → completed across two calls both pass", () => {
		const first = makeItems("in_progress");
		expect(validateItems(first)).toBeNull();
		const second = makeItems("completed");
		expect(validateItems(second, first)).toBeNull();
	});

	it("completed → in_progress is rejected as invalid transition", () => {
		const before = makeItems("completed");
		const after = makeItems("in_progress");
		const error = validateItems(after, before);
		expect(error).not.toBeNull();
		expect(error).toMatch(/transition/i);
	});
});

describe("validateItems — content validation", () => {
	it("rejects item with empty content", () => {
		const items: TodoItem[] = [{ id: "1", content: "", status: "pending" }];
		const error = validateItems(items);
		expect(error).not.toBeNull();
		expect(error).toMatch(/content/i);
	});
});

describe("todowrite tool — execute integration", () => {
	type Execute = (
		toolCallId: string,
		params: { items: TodoItem[] },
	) => Promise<{ content: Array<{ type: string; text: string }>; details: { error?: string; items?: TodoItem[]; currentTodos?: string } }>;

	let execute: Execute;

	beforeEach(() => {
		const tools = new Map<string, { name: string; execute: Execute }>();
		const pi = {
			on: (_event: string, _handler: unknown) => {},
			registerTool: (tool: { name: string; execute: Execute }) => {
				tools.set(tool.name, tool);
			},
		};
		registerTools(pi as unknown as Parameters<typeof registerTools>[0]);
		const tool = tools.get("todowrite");
		if (!tool) throw new Error("todowrite tool not registered");
		execute = tool.execute;
	});

	it("transcript bug scenario: full-list re-send with one item flipped to in_progress succeeds", async () => {
		const first = [
			{ id: "tx-1", content: "step 1", status: "pending" as const },
			{ id: "tx-2", content: "step 2", status: "pending" as const },
			{ id: "tx-3", content: "step 3", status: "pending" as const },
			{ id: "tx-4", content: "step 4", status: "pending" as const },
			{ id: "tx-5", content: "step 5", status: "pending" as const },
		];

		const r1 = await execute("c1", { items: first });
		expect(r1.details.error).toBeUndefined();
		expect(r1.details.items).toHaveLength(5);

		const second = first.map((it, i) =>
			i === 2 ? { ...it, status: "in_progress" as const } : it,
		);
		const r2 = await execute("c2", { items: second });
		expect(r2.details.error).toBeUndefined();
		const updated = r2.details.items?.find((i) => i.id === "tx-3");
		expect(updated?.status).toBe("in_progress");
		const unchanged = r2.details.items?.find((i) => i.id === "tx-1");
		expect(unchanged?.status).toBe("pending");
	});

	it("MAX_IN_PROGRESS boundary: 3 in_progress passes, 4 errors", async () => {
		const three = [
			{ id: "max-1", content: "a", status: "in_progress" as const },
			{ id: "max-2", content: "b", status: "in_progress" as const },
			{ id: "max-3", content: "c", status: "in_progress" as const },
		];
		const r3 = await execute("c3", { items: three });
		expect(r3.details.error).toBeUndefined();

		const four = [
			...three,
			{ id: "max-4", content: "d", status: "in_progress" as const },
		];
		const r4 = await execute("c4", { items: four });
		expect(r4.details.error).toMatch(/3/);
		expect(r4.content[0]?.text).toMatch(/3/);
		expect(r4.details.currentTodos).toBeDefined();
		expect(r4.details.currentTodos).toContain("max-1");
		expect(r4.details.currentTodos).toContain("max-3");
	});

	it("execute replaces global todoItems state on success", async () => {
		const items = [
			{ id: "mut-1", content: "x", status: "completed" as const },
			{ id: "mut-2", content: "y", status: "in_progress" as const },
		];
		const result = await execute("c5", { items });
		expect(result.details.items).toEqual([
			{ id: "mut-1", content: "x", status: "completed" },
			{ id: "mut-2", content: "y", status: "in_progress" },
		]);
		expect(result.content[0]?.text).toMatch(/1\/2 completed/);
	});

	it("error path returns details.currentTodos reflecting prior successful state", async () => {
		const setup = await execute("c6", {
			items: [
				{ id: "err-1", content: "task a", status: "pending" as const },
				{ id: "err-2", content: "task b", status: "completed" as const },
			],
		});
		expect(setup.details.error).toBeUndefined();

		const trigger = await execute("c7", {
			items: [
				{ id: "err-1", content: "task a", status: "pending" as const },
				{ id: "err-2", content: "task b", status: "in_progress" as const },
			],
		});

		expect(trigger.details.error).toMatch(/transition/i);
		expect(trigger.content[0]?.text).toMatch(/transition/i);
		expect(trigger.details.currentTodos).toContain("task a");
		expect(trigger.details.currentTodos).toContain("task b");
		expect(trigger.details.currentTodos).toMatch(/1\/2 completed/);
	});
});
