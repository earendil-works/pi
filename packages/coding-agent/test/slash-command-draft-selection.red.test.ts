import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

type TestRenderer = {
	init(): Promise<void>;
	stop(): void;
	openSlashCommandOverlay(): void;
	slashCommandOverlay: { handleInput(data: string): void } | null;
	editor: { getText(): string };
	showError(errorMessage: string): void;
	showWarning(message: string): void;
};

async function makeRenderer(): Promise<{
	renderer: TestRenderer;
	settings: SettingsManager;
	cleanup(): void;
}> {
	initTheme("dark");
	const baseDir = mkdtempSync(join(tmpdir(), "mu-slash-draft-selection-"));
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

	const settings = new SettingsManager(baseDir);
	const renderer = new TuiRenderer(
		agent,
		{
			loadTitle: () => null,
			getSessionId: () => "slash-command-draft-selection-red",
		} as never,
		settings,
		{
			listCommands: () => [],
			getCommand: () => undefined,
			applyInputHooks: async (text: string) => ({ handled: false, text }),
			composeToolResultTransformer: <T>(base: T) => base,
		} as never,
		{} as never,
		"0.0.0",
	) as unknown as TestRenderer;

	await renderer.init();

	return {
		renderer,
		settings,
		cleanup() {
			renderer.stop();
			rmSync(baseDir, { recursive: true, force: true });
		},
	};
}

function selectSlashCommand(renderer: TestRenderer, query: string): void {
	renderer.openSlashCommandOverlay();
	const overlay = renderer.slashCommandOverlay;
	if (!overlay) {
		throw new Error("Slash command overlay did not open");
	}

	for (const char of query) {
		overlay.handleInput(char);
	}
	overlay.handleInput("\r");
}

describe("slash command draft selection", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("injects a /compact draft instead of running the bare command from the slash dialog", async () => {
		const { renderer, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		const errors: string[] = [];
		const warnings: string[] = [];
		const originalShowError = renderer.showError.bind(renderer);
		const originalShowWarning = renderer.showWarning.bind(renderer);
		renderer.showError = (message: string) => {
			errors.push(message);
			originalShowError(message);
		};
		renderer.showWarning = (message: string) => {
			warnings.push(message);
			originalShowWarning(message);
		};

		selectSlashCommand(renderer, "comp");

		expect(renderer.editor.getText()).toBe("/compact ");
		expect(errors).toEqual([]);
		expect(warnings).toContain(
			"Prepared /compact draft. Modes: --summary <goal> | --inject <goal> | on | off | toggle | status",
		);
	});

	it("injects a /fast draft instead of toggling fast mode from the slash dialog", async () => {
		const { renderer, settings, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		expect(settings.getFastMode()).toBe(false);

		selectSlashCommand(renderer, "fas");

		expect(renderer.editor.getText()).toBe("/fast ");
		expect(settings.getFastMode()).toBe(false);
	});

	it("injects a /usage draft instead of toggling usage footer mode from the slash dialog", async () => {
		const { renderer, settings, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		expect(settings.getUsageFooterMode()).toBe("hidden");

		selectSlashCommand(renderer, "usa");

		expect(renderer.editor.getText()).toBe("/usage ");
		expect(settings.getUsageFooterMode()).toBe("hidden");
	});

	it("injects a /mission-run draft instead of executing the bare command from the slash dialog", async () => {
		const { renderer, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		const errors: string[] = [];
		const warnings: string[] = [];
		const originalShowError = renderer.showError.bind(renderer);
		const originalShowWarning = renderer.showWarning.bind(renderer);
		renderer.showError = (message: string) => {
			errors.push(message);
			originalShowError(message);
		};
		renderer.showWarning = (message: string) => {
			warnings.push(message);
			originalShowWarning(message);
		};

		selectSlashCommand(renderer, "miss");

		expect(renderer.editor.getText()).toBe("/mission-run ");
		expect(errors).toEqual([]);
		expect(warnings).toContain("Prepared /mission-run draft. Enter a mission name or path.");
	});
});
