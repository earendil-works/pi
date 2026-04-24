import { describe, expect, it } from "vitest";
import { writeTool } from "./write.js";

describe("writeTool.getResourceKey", () => {
	it("returns a file resource key for a normal path", () => {
		const key = writeTool.getResourceKey?.({ path: "/tmp/test.md", content: "# hi" });
		expect(key).toBe("file:/tmp/test.md");
	});

	it("returns null for undefined path", () => {
		const key = writeTool.getResourceKey?.({ path: undefined as any, content: "# hi" });
		expect(key).toBeUndefined();
	});

	it("returns null for null path", () => {
		const key = writeTool.getResourceKey?.({ path: null as any, content: "# hi" });
		expect(key).toBeUndefined();
	});

	it("returns null for numeric path", () => {
		const key = writeTool.getResourceKey?.({ path: 42 as any, content: "# hi" });
		expect(key).toBeUndefined();
	});

	it("returns null for empty args", () => {
		const key = writeTool.getResourceKey?.({} as any);
		expect(key).toBeUndefined();
	});
});
