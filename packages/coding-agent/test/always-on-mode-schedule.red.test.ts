import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

type ScheduleRenderer = {
	init(): Promise<void>;
	stop(): void;
	handleEditorTextSubmission(text: string, kind: "by-end" | "next"): Promise<void>;
	alwaysOnService?: {
		submit(
			spec:
				| { kind: "once"; instruction: string; at: string }
				| { kind: "recurring"; instruction: string; cron: string; timezone?: string },
		): Promise<{ workItemId: string }>;
	};
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

describe("always-on schedule commands (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("routes /always-on-schedule --at ... through the shared always-on submission API instead of immediate mode submission", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-always-on-schedule-red-"));
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
				getSessionId: () => "always-on-schedule-red",
				reset: () => {},
			} as never,
			new SettingsManager(configDir),
			createExtensionManagerStub() as never,
			{} as never,
			"0.0.0",
		) as unknown as ScheduleRenderer;

		await renderer.init();
		cleanups.push(() => renderer.stop());

		const submissions: Array<
			| { kind: "once"; instruction: string; at: string }
			| { kind: "recurring"; instruction: string; cron: string; timezone?: string }
		> = [];
		const normalChatSubmissions: string[] = [];
		renderer.onInputCallback = (text: string) => {
			normalChatSubmissions.push(text);
		};
		renderer.alwaysOnService = {
			submit: async (spec) => {
				submissions.push(spec);
				return { workItemId: "job-schedule-red" };
			},
		};

		await renderer.handleEditorTextSubmission("/always-on", "by-end");
		await renderer.handleEditorTextSubmission(
			"/always-on-schedule --at 2026-04-10T00:05:00.000Z Run once later",
			"by-end",
		);

		expect(submissions).toEqual([{ kind: "once", at: "2026-04-10T00:05:00.000Z", instruction: "Run once later" }]);
		expect(normalChatSubmissions).toEqual([]);
	});
});
