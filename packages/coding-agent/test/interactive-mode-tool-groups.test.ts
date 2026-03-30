import { describe, expect, it, vi } from "vitest";
import type { ToolGroupDefinition } from "../src/core/extensions/types.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

describe("InteractiveMode - findMatchingGroupDefinition", () => {
	function callFindMatching(
		definitions: ToolGroupDefinition[] | undefined,
		toolName: string,
		args: unknown,
	): ToolGroupDefinition | undefined {
		const fakeThis: any = {
			session: {
				extensionRunner: definitions
					? {
							getRegisteredToolGroupDefinitions: () => definitions,
						}
					: undefined,
			},
		};
		return (InteractiveMode as any).prototype.findMatchingGroupDefinition.call(fakeThis, toolName, args);
	}

	it("returns first matching definition", () => {
		const defA: ToolGroupDefinition = {
			name: "group-a",
			match: (toolName) => toolName === "read",
			render: () => null,
		};
		const defB: ToolGroupDefinition = {
			name: "group-b",
			match: (toolName) => toolName === "read",
			render: () => null,
		};

		const result = callFindMatching([defA, defB], "read", {});
		expect(result).toBe(defA);
	});

	it("returns undefined when no definition matches", () => {
		const def: ToolGroupDefinition = {
			name: "group-a",
			match: (toolName) => toolName === "read",
			render: () => null,
		};

		const result = callFindMatching([def], "bash", {});
		expect(result).toBeUndefined();
	});

	it("returns undefined when extensionRunner is undefined", () => {
		const result = callFindMatching(undefined, "read", {});
		expect(result).toBeUndefined();
	});

	it("returns undefined when no definitions are registered", () => {
		const result = callFindMatching([], "read", {});
		expect(result).toBeUndefined();
	});

	it("wraps match() in try-catch and skips throwing definitions", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const throwingDef: ToolGroupDefinition = {
			name: "broken",
			match: () => {
				throw new Error("match exploded");
			},
			render: () => null,
		};
		const goodDef: ToolGroupDefinition = {
			name: "good",
			match: (toolName) => toolName === "read",
			render: () => null,
		};

		const result = callFindMatching([throwingDef, goodDef], "read", {});
		expect(result).toBe(goodDef);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("broken"), expect.any(Error));

		warnSpy.mockRestore();
	});

	it("skips throwing definition and returns undefined when no other matches", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const throwingDef: ToolGroupDefinition = {
			name: "broken",
			match: () => {
				throw new Error("match exploded");
			},
			render: () => null,
		};

		const result = callFindMatching([throwingDef], "read", {});
		expect(result).toBeUndefined();
		expect(warnSpy).toHaveBeenCalled();

		warnSpy.mockRestore();
	});

	it("passes toolName and args to match()", () => {
		const matchSpy = vi.fn().mockReturnValue(true);
		const def: ToolGroupDefinition = {
			name: "spy-group",
			match: matchSpy,
			render: () => null,
		};
		const args = { path: "/foo/bar.ts" };

		callFindMatching([def], "read", args);
		expect(matchSpy).toHaveBeenCalledWith("read", args);
	});
});
