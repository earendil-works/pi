import { describe, expect, it } from "vitest";
import { editTool } from "./edit.js";

describe("editTool.getResourceKey", () => {
	it("returns a file resource key for a normal path", () => {
		const key = editTool.getResourceKey?.({ path: "/tmp/test.md", oldText: "hi", newText: "bye" });
		expect(key).toBe("file:/tmp/test.md");
	});

	it("returns null for undefined path", () => {
		const key = editTool.getResourceKey?.({ path: undefined as any, oldText: "hi", newText: "bye" });
		expect(key).toBeUndefined();
	});

	it("returns null for null path", () => {
		const key = editTool.getResourceKey?.({ path: null as any, oldText: "hi", newText: "bye" });
		expect(key).toBeUndefined();
	});

	it("returns null for numeric path", () => {
		const key = editTool.getResourceKey?.({ path: 42 as any, oldText: "hi", newText: "bye" });
		expect(key).toBeUndefined();
	});

	it("returns null for empty args", () => {
		const key = editTool.getResourceKey?.({} as any);
		expect(key).toBeUndefined();
	});
});
