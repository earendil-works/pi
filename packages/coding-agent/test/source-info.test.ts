import { afterEach, describe, expect, it } from "vitest";
import { getResourcePathKey } from "../src/core/source-info.ts";

describe("getResourcePathKey", () => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

	afterEach(() => {
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
	});

	// Regression test for https://github.com/earendil-works/pi/issues/10488
	it("folds file path casing on Windows but keeps synthetic identifiers unchanged", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		expect(getResourcePathKey("C:\\Users\\Me\\ext.ts")).toBe(getResourcePathKey("c:\\users\\me\\ext.ts"));
		expect(getResourcePathKey("builtin:MCP")).toBe("builtin:MCP");
		expect(getResourcePathKey("builtin:MCP")).not.toBe(getResourcePathKey("builtin:mcp"));
		expect(getResourcePathKey("<inline:Name>")).toBe("<inline:Name>");
	});
});
