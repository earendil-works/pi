import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

type FollowUpRenderer = {
	init(): Promise<void>;
	stop(): void;
	handleEditorTextSubmission(text: string, kind: "by-end" | "next"): Promise<void>;
	alwaysOnService?: {
		submit(spec: {
			kind: "follow_up";
			instruction: string;
			parentWorkItemId: string;
		}): Promise<{ workItemId: string }>;
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

describe("always-on follow-up command (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("routes /always-on-follow-up <job-id> ... through follow-up submission instead of immediate mode submission", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-always-on-followup-red-"));
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
				getSessionId: () => "always-on-followup-red",
				reset: () => {},
			} as never,
			new SettingsManager(configDir),
			createExtensionManagerStub() as never,
			{} as never,
			"0.0.0",
		) as unknown as FollowUpRenderer;

		await renderer.init();
		cleanups.push(() => renderer.stop());

		const submissions: Array<{ kind: "follow_up"; instruction: string; parentWorkItemId: string }> = [];
		const normalChatSubmissions: string[] = [];
		renderer.onInputCallback = (text: string) => {
			normalChatSubmissions.push(text);
		};
		renderer.alwaysOnService = {
			submit: async (spec) => {
				submissions.push(spec);
				return { workItemId: "job-followup-red" };
			},
		};

		await renderer.handleEditorTextSubmission("/always-on", "by-end");
		await renderer.handleEditorTextSubmission("/always-on-follow-up job-parent Continue the prior task", "by-end");

		expect(submissions).toEqual([
			{ kind: "follow_up", parentWorkItemId: "job-parent", instruction: "Continue the prior task" },
		]);
		expect(normalChatSubmissions).toEqual([]);
	});
});
