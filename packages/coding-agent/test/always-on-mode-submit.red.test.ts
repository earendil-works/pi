import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

type AlwaysOnSubmitRenderer = {
	init(): Promise<void>;
	stop(): void;
	handleEditorTextSubmission(text: string, kind: "by-end" | "next"): Promise<void>;
	onInputCallback?: (text: string) => void;
	alwaysOnService?: {
		submit(spec: { kind: "immediate"; instruction: string }): Promise<{ workItemId: string; runId?: string }>;
	};
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

describe("always-on mode plain-text submission (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("routes plain text to always-on immediate submission instead of normal chat while the mode is active", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-always-on-submit-red-"));
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
				getSessionId: () => "always-on-submit-red",
				reset: () => {},
			} as never,
			new SettingsManager(configDir),
			createExtensionManagerStub() as never,
			{} as never,
			"0.0.0",
		) as unknown as AlwaysOnSubmitRenderer;

		await renderer.init();
		cleanups.push(() => renderer.stop());

		const normalChatSubmissions: string[] = [];
		const alwaysOnSubmissions: Array<{ kind: "immediate"; instruction: string }> = [];
		renderer.onInputCallback = (text: string) => {
			normalChatSubmissions.push(text);
		};
		renderer.alwaysOnService = {
			submit: async (spec) => {
				alwaysOnSubmissions.push(spec);
				return { workItemId: "job-red", runId: "run-red" };
			},
		};

		await renderer.handleEditorTextSubmission("/always-on", "by-end");
		await renderer.handleEditorTextSubmission("Summarize the README", "by-end");

		expect(alwaysOnSubmissions).toEqual([{ kind: "immediate", instruction: "Summarize the README" }]);
		expect(normalChatSubmissions).toEqual([]);
	});
});
