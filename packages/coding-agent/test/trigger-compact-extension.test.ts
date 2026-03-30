import { describe, expect, test, vi } from "vitest";
import triggerCompactExtension from "../examples/extensions/trigger-compact.js";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../src/core/extensions/index.js";

function createContext(tokens: number | null, compact = vi.fn()): ExtensionContext {
	return {
		hasUI: false,
		ui: {} as ExtensionContext["ui"],
		cwd: process.cwd(),
		sessionManager: {} as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: tokens === null ? null : tokens / 2000 }),
		compact,
		getSystemPrompt: () => "",
	};
}

describe("trigger-compact example extension", () => {
	test("only auto-compacts when context usage crosses the threshold", () => {
		let turnEndHandler:
			| ((event: { type: "turn_end" }, ctx: ExtensionContext | ExtensionCommandContext) => void)
			| undefined;

		const api = {
			on: (event: string, handler: (event: { type: "turn_end" }, ctx: ExtensionContext) => void) => {
				if (event === "turn_end") {
					turnEndHandler = handler;
				}
			},
			registerCommand: vi.fn(),
		} as unknown as ExtensionAPI;

		triggerCompactExtension(api);
		expect(turnEndHandler).toBeDefined();

		const compact = vi.fn();
		const event = { type: "turn_end" } as const;

		turnEndHandler?.(event, createContext(110_000, compact));
		expect(compact).not.toHaveBeenCalled();

		turnEndHandler?.(event, createContext(120_000, compact));
		expect(compact).not.toHaveBeenCalled();

		turnEndHandler?.(event, createContext(95_000, compact));
		expect(compact).not.toHaveBeenCalled();

		turnEndHandler?.(event, createContext(105_000, compact));
		expect(compact).toHaveBeenCalledTimes(1);
	});
});
