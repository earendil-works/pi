import { describe, expect, it } from "vitest";
import { ExtensionManager } from "../src/extensions/manager.js";
import type { ExtensionCommandContext } from "../src/extensions/types.js";
import { initTheme, theme } from "../src/theme/theme.js";

describe("Spec/Discover Mode Color Override", () => {
	it("spec mode color should be different from thinking colors", () => {
		initTheme("dark");

		// Get spec mode color
		const specColorFn = theme.getModeBorderColor("spec");
		const specOutput = specColorFn("test");

		// Get thinking medium color (most likely to conflict)
		const thinkingMediumFn = theme.getThinkingBorderColor("medium");
		const thinkingOutput = thinkingMediumFn("test");

		// They should produce different ANSI codes
		expect(specOutput).not.toEqual(thinkingOutput);
		console.log("Spec mode:", specOutput);
		console.log("Thinking medium:", thinkingOutput);
	});

	it("discover mode color should be different from thinking colors", () => {
		initTheme("dark");

		// Get discover mode color
		const discoverColorFn = theme.getModeBorderColor("discover");
		const discoverOutput = discoverColorFn("test");

		// Get thinking high color (most likely to conflict)
		const thinkingHighFn = theme.getThinkingBorderColor("high");
		const thinkingOutput = thinkingHighFn("test");

		// They should produce different ANSI codes
		expect(discoverOutput).not.toEqual(thinkingOutput);
		console.log("Discover mode:", discoverOutput);
		console.log("Thinking high:", thinkingOutput);
	});

	it("null mode should return identity function", () => {
		initTheme("dark");

		const nullColorFn = theme.getModeBorderColor(null);
		const output = nullColorFn("test");

		// Should return text unchanged (no ANSI codes)
		expect(output).toEqual("test");
	});

	it("mode cursor accents should be defined", () => {
		initTheme("dark");

		const specCursor = theme.getModeCursorAccentAnsi("spec");
		const discoverCursor = theme.getModeCursorAccentAnsi("discover");

		expect(specCursor).toBeDefined();
		expect(specCursor?.fgAnsi).toBeDefined();
		expect(specCursor?.bgAnsi).toBeDefined();

		expect(discoverCursor).toBeDefined();
		expect(discoverCursor?.fgAnsi).toBeDefined();
		expect(discoverCursor?.bgAnsi).toBeDefined();

		console.log("Spec cursor:", specCursor);
		console.log("Discover cursor:", discoverCursor);
	});

	it("null mode cursor accent should be null", () => {
		initTheme("dark");

		const nullCursor = theme.getModeCursorAccentAnsi(null);
		expect(nullCursor).toBeNull();
	});
});

describe("ExtensionManager indicator detection for mode colors", () => {
	it("should detect spec mode from indicators", async () => {
		const manager = new ExtensionManager({
			builtInTools: {},
			builtInSourceId: "test",
		});

		// Simulate spec-mode extension registering an indicator
		await manager.loadExtension((api) => {
			api.registerExtensionIndicator({
				id: "spec-mode",
				label: "[SPEC]",
				color: "accent",
			});
		}, "~/.mu/agent/extensions/spec-mode/index.ts");

		const indicators = manager.getIndicators();
		expect(indicators.length).toBeGreaterThan(0);

		const hasSpecIndicator = indicators.some(
			(ind) => ind.label.includes("SPEC") || ind.label.toLowerCase().includes("spec"),
		);
		expect(hasSpecIndicator).toBe(true);
	});

	it("should detect discover mode from indicators", async () => {
		const manager = new ExtensionManager({
			builtInTools: {},
			builtInSourceId: "test",
		});

		// Simulate discover extension registering an indicator
		await manager.loadExtension((api) => {
			api.registerExtensionIndicator({
				id: "discover-mode",
				label: "[DISCOVER]",
				color: "warning",
			});
		}, "~/.mu/agent/extensions/discover-mode/index.ts");

		const indicators = manager.getIndicators();
		expect(indicators.length).toBeGreaterThan(0);

		const hasDiscoverIndicator = indicators.some(
			(ind) => ind.label.includes("DISCOVER") || ind.label.toLowerCase().includes("discover"),
		);
		expect(hasDiscoverIndicator).toBe(true);
	});
});

// Helper function that mimics getActiveModeFromIndicators in tui-renderer.ts
function getActiveModeFromIndicators(
	indicators: Array<{ id: string; label: string; color: string; priority: number }>,
): "spec" | "discover" | null {
	for (const indicator of indicators) {
		if (indicator.label.includes("SPEC") || indicator.label.includes("spec")) {
			return "spec";
		}
		if (indicator.label.includes("DISCOVER") || indicator.label.includes("discover")) {
			return "discover";
		}
	}
	return null;
}

describe("getActiveModeFromIndicators logic", () => {
	it("should return spec when [SPEC] indicator present", () => {
		const indicators = [{ id: "1", label: "[SPEC]", color: "accent", priority: 0 }];
		expect(getActiveModeFromIndicators(indicators)).toBe("spec");
	});

	it("should return discover when [DISCOVER] indicator present", () => {
		const indicators = [{ id: "1", label: "[DISCOVER]", color: "warning", priority: 0 }];
		expect(getActiveModeFromIndicators(indicators)).toBe("discover");
	});

	it("should return null when no mode indicators present", () => {
		const indicators = [{ id: "1", label: "[OTHER]", color: "muted", priority: 0 }];
		expect(getActiveModeFromIndicators(indicators)).toBeNull();
	});

	it("should return null for empty indicators", () => {
		expect(getActiveModeFromIndicators([])).toBeNull();
	});

	it("should be case insensitive for spec", () => {
		expect(getActiveModeFromIndicators([{ id: "1", label: "[spec]", color: "accent", priority: 0 }])).toBe("spec");
		expect(getActiveModeFromIndicators([{ id: "1", label: "SPEC", color: "accent", priority: 0 }])).toBe("spec");
	});

	it("should be case insensitive for discover", () => {
		expect(getActiveModeFromIndicators([{ id: "1", label: "[discover]", color: "warning", priority: 0 }])).toBe(
			"discover",
		);
		expect(getActiveModeFromIndicators([{ id: "1", label: "DISCOVER", color: "warning", priority: 0 }])).toBe(
			"discover",
		);
	});
});
