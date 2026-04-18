import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

type AlwaysOnModeRenderer = {
	init(): Promise<void>;
	stop(): void;
	handleEditorTextSubmission(text: string, kind: "by-end" | "next"): Promise<void>;
	getComposerMetaLabel(): string;
	onInputCallback?: (text: string) => void;
};

function createExtensionManagerStub() {
	return {
		listCommands: () => [],
		getCommand: () => undefined,
		getIndicators: () => [],
		applyInputHooks: async (text: string) => ({ handled: false, text }),
		composeToolResultTransformer: <T>(base: T) => base,
	};
}

describe("always-on TUI mode (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("treats /always-on and /always-on-exit as built-in mode transitions instead of normal chat submissions", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-always-on-mode-red-"));
		cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));

		const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-openai-key";
		cleanups.push(() => {
			if (previousOpenAiApiKey === undefined) {
				delete process.env.OPENAI_API_KEY;
			} else {
				process.env.OPENAI_API_KEY = previousOpenAiApiKey;
			}
		});

		const agent = new Agent({
			transport: {
				async *run() {
					yield* [];
				},
			} as never,
			initialState: {
				model: getModel("openai", "gpt-4o-mini"),
				thinkingLevel: "medium",
			},
		});

		const renderer = new TuiRenderer(
			agent,
			{
				appendContextCompaction: () => {},
				loadTitle: () => null,
				getSessionId: () => "always-on-mode-red",
				reset: () => {},
			} as never,
			new SettingsManager(configDir),
			createExtensionManagerStub() as never,
			{} as never,
			"0.0.0",
		) as unknown as AlwaysOnModeRenderer;

		await renderer.init();
		cleanups.push(() => renderer.stop());

		const submittedTexts: string[] = [];
		renderer.onInputCallback = (text: string) => {
			submittedTexts.push(text);
		};

		await renderer.handleEditorTextSubmission("/always-on", "by-end");
		expect(submittedTexts).toEqual([]);
		expect(stripAnsi(renderer.getComposerMetaLabel()).toLowerCase()).toContain("always-on");

		await renderer.handleEditorTextSubmission("/always-on-exit", "by-end");
		expect(submittedTexts).toEqual([]);
		expect(stripAnsi(renderer.getComposerMetaLabel()).toLowerCase()).not.toContain("always-on");

		await renderer.handleEditorTextSubmission("normal chat still works", "by-end");
		expect(submittedTexts).toEqual(["normal chat still works"]);
	});
});
