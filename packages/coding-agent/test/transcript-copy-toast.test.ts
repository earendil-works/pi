import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

async function makeRenderer() {
	initTheme("dark");
	const agent = new Agent({
		transport: {
			async *run() {
				yield* [];
			},
		} as never,
		initialState: {
			model: getModel("openai-codex", "gpt-5.4"),
			thinkingLevel: "medium",
		},
	});

	const renderer = new TuiRenderer(
		agent,
		{
			loadTitle: () => null,
			getSessionId: () => "transcript-copy-toast-test",
		} as never,
		new SettingsManager(process.cwd()),
		{
			listCommands: () => [],
			getCommand: () => undefined,
			applyInputHooks: async (text: string) => ({ handled: false, text }),
			composeToolResultTransformer: <T>(base: T) => base,
		} as never,
		{} as never,
		"0.0.0",
	);

	await renderer.init();
	return renderer as unknown as {
		stop(): void;
		handleTranscriptSelectionCopy(text: string): void;
		showThemeSelector(): void;
		ui: {
			render(width: number): string[];
			setOverlay(component: unknown, options?: unknown): void;
			clearOverlay(): void;
			requestRender(): void;
		};
		chatContainer: {
			children: unknown[];
		};
	};
}

describe("transcript copy toast", () => {
	const renderers: Array<{ stop(): void }> = [];

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		for (const renderer of renderers.splice(0)) {
			renderer.stop();
		}
	});

	it("shows a top overlay toast and auto-dismisses it without mutating chat history", async () => {
		const renderer = await makeRenderer();
		renderers.push(renderer);

		const originalSetOverlay = renderer.ui.setOverlay.bind(renderer.ui);
		const originalClearOverlay = renderer.ui.clearOverlay.bind(renderer.ui);
		const originalRequestRender = renderer.ui.requestRender.bind(renderer.ui);

		let overlayCalls = 0;
		let clearCalls = 0;
		let requestRenderCalls = 0;
		let lastOptions: unknown;

		renderer.ui.setOverlay = (component: unknown, options?: unknown) => {
			overlayCalls++;
			lastOptions = options;
			originalSetOverlay(component, options);
		};
		renderer.ui.clearOverlay = () => {
			clearCalls++;
			originalClearOverlay();
		};
		renderer.ui.requestRender = () => {
			requestRenderCalls++;
			originalRequestRender();
		};

		const initialChildren = renderer.chatContainer.children.length;

		renderer.handleTranscriptSelectionCopy("copied from transcript");

		expect(overlayCalls).toBe(1);
		expect(requestRenderCalls).toBeGreaterThanOrEqual(1);
		expect(renderer.chatContainer.children.length).toBe(initialChildren);
		expect(lastOptions).toMatchObject({ marginTop: 1 });

		const visibleRows = renderer.ui.render(80).map(stripAnsi);
		const toastRow = visibleRows.findIndex((line) => line.includes("Text Copied to Clipboard"));
		expect(toastRow).toBeGreaterThanOrEqual(0);
		expect(toastRow).toBeGreaterThan(0);
		expect(toastRow).toBeLessThanOrEqual(3);
		expect(visibleRows[toastRow - 1]?.includes("╭")).toBe(true);
		expect(visibleRows[toastRow]?.includes("│")).toBe(true);
		expect(visibleRows[toastRow + 1]?.includes("╰")).toBe(true);

		await vi.advanceTimersByTimeAsync(1400);

		expect(clearCalls).toBe(1);
		expect(requestRenderCalls).toBeGreaterThanOrEqual(2);
		expect(
			renderer.ui
				.render(80)
				.map(stripAnsi)
				.some((line) => line.includes("Text Copied to Clipboard")),
		).toBe(false);
	});

	it("does not replace an active dialog overlay with the copy toast", async () => {
		const renderer = await makeRenderer();
		renderers.push(renderer);

		renderer.showThemeSelector();
		const originalSetOverlay = renderer.ui.setOverlay.bind(renderer.ui);
		let overlayCalls = 0;
		renderer.ui.setOverlay = (component: unknown, options?: unknown) => {
			overlayCalls++;
			originalSetOverlay(component, options);
		};

		const beforeRows = renderer.ui.render(80).map(stripAnsi);
		expect(beforeRows.some((line) => line.includes("Theme"))).toBe(true);

		renderer.handleTranscriptSelectionCopy("copied from transcript");

		const afterRows = renderer.ui.render(80).map(stripAnsi);
		expect(overlayCalls).toBe(0);
		expect(afterRows.some((line) => line.includes("Theme"))).toBe(true);
		expect(afterRows.some((line) => line.includes("Text Copied to Clipboard"))).toBe(false);
	});
});
