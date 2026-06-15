import { describe, expect, it } from "vitest";
import { validateItems } from "../tools.ts";
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
