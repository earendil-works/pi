import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTransport } from "@kennyfrc/mu-agent-core";
import { getModel, type Message } from "@kennyfrc/mu-ai";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

type MissionRenderer = {
	init(): Promise<void>;
	stop(): void;
	showError(errorMessage: string): void;
	showWarning(message: string): void;
	handleEditorTextSubmission(text: string, kind: "by-end" | "next"): Promise<void>;
	buildSummaryCompactionDetails(
		goal: string,
		signal: AbortSignal,
	): Promise<{
		handoffType: "explicit";
		goal: string;
		formattedMessage: string;
		parentSessionId: string;
		fileTokens: number;
		keyFiles?: string[];
	}>;
};

const COMPACTION_CONTINUATION_PREFIX = "Continue the task from the compacted checkpoint.";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeMissionFiles(dir: string): void {
	writeFileSync(join(dir, "SPEC.md"), "# Goal\nShip /mission-run\n");
	writeFileSync(join(dir, "PROGRESS.md"), "# Progress\n\n## Status\n- still working\n");
	writeFileSync(join(dir, "RUNBOOK.md"), "# Runbook\n\n1. Do one iteration.\n");
}

function writeMissionTasks(dir: string, status: "todo" | "done"): void {
	writeFileSync(
		join(dir, "TASKS.json"),
		JSON.stringify(
			{
				tasks: [{ id: "baseline", title: status, status, validation: [], notes: "" }],
			},
			null,
			2,
		),
	);
}

function extractText(message: Message): string {
	const content = Array.isArray(message.content)
		? message.content
		: [{ type: "text" as const, text: String(message.content) }];
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function createMissionRenderer(args: {
	configDir: string;
	agent: Agent;
	warnings: string[];
	errors: string[];
}): MissionRenderer {
	const renderer = new TuiRenderer(
		args.agent,
		{
			appendContextCompaction: () => {},
			loadTitle: () => null,
			getSessionId: () => "mission-compact-red",
		} as never,
		new SettingsManager(args.configDir),
		{
			listCommands: () => [],
			getCommand: () => undefined,
			applyInputHooks: async (text: string) => ({ handled: false, text }),
			composeToolResultTransformer: <T>(base: T) => base,
		} as never,
		{} as never,
		"0.0.0",
	) as unknown as MissionRenderer;

	renderer.showWarning = (message: string) => {
		args.warnings.push(message);
	};
	renderer.showError = (message: string) => {
		args.errors.push(message);
	};

	return renderer;
}

describe("mission loop compact handling (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("does not fire an extra plain compaction continuation after a compacted mission iteration already finishes the mission", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-mission-compact-red-config-"));
		const missionDir = mkdtempSync(join(tmpdir(), "mu-mission-compact-red-done-"));
		cleanups.push(
			() => rmSync(configDir, { recursive: true, force: true }),
			() => rmSync(missionDir, { recursive: true, force: true }),
		);

		writeMissionFiles(missionDir);
		writeMissionTasks(missionDir, "todo");

		const previousOpenAiKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-openai-key";
		cleanups.push(() => {
			if (previousOpenAiKey === undefined) {
				delete process.env.OPENAI_API_KEY;
			} else {
				process.env.OPENAI_API_KEY = previousOpenAiKey;
			}
		});

		const prompts: string[] = [];
		const warnings: string[] = [];
		const errors: string[] = [];
		let runCount = 0;

		const transport: AgentTransport = {
			async *run(_messages, userMessage) {
				runCount += 1;
				prompts.push(extractText(userMessage));

				if (runCount === 1) {
					writeMissionTasks(missionDir, "done");
					yield {
						type: "tool_execution_end",
						toolCallId: "tool-compact-finish",
						toolName: "compact",
						isError: false,
						result: {
							content: [{ type: "text", text: 'Compaction requested: "Continue mission compact-red"' }],
							details: {
								handoffType: "explicit",
								goal: "Continue mission compact-red",
								formattedMessage: "",
								parentSessionId: "",
								fileTokens: 0,
								keyFiles: [],
							},
						},
					};
				}

				yield { type: "agent_end", messages: [] };
			},
		};

		const agent = new Agent({
			transport,
			initialState: {
				model: getModel("openai", "gpt-4o-mini"),
				thinkingLevel: "medium",
			},
		});
		const renderer = createMissionRenderer({ configDir, agent, warnings, errors });
		renderer.buildSummaryCompactionDetails = async (goal) => ({
			handoffType: "explicit",
			goal,
			formattedMessage: "# Handoff: Continue mission compact-red",
			parentSessionId: "",
			fileTokens: 55,
			keyFiles: ["TASKS.json"],
		});
		cleanups.push(() => renderer.stop());

		await renderer.init();
		await renderer.handleEditorTextSubmission(`/mission-run ${missionDir}`, "by-end");
		await sleep(300);
		await agent.waitForIdle();

		expect(errors).toEqual([]);
		expect(warnings.join("\n")).toMatch(/done after 1 iteration/i);
		expect(runCount).toBe(1);
		expect(prompts.some((prompt) => prompt.includes(COMPACTION_CONTINUATION_PREFIX))).toBe(false);
	});

	it("treats model-invoked compact inside a mission as a next-iteration transition rather than an extra plain continuation prompt", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-mission-compact-red-config-"));
		const missionDir = mkdtempSync(join(tmpdir(), "mu-mission-compact-red-todo-"));
		cleanups.push(
			() => rmSync(configDir, { recursive: true, force: true }),
			() => rmSync(missionDir, { recursive: true, force: true }),
		);

		writeMissionFiles(missionDir);
		writeMissionTasks(missionDir, "todo");

		const previousOpenAiKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-openai-key";
		cleanups.push(() => {
			if (previousOpenAiKey === undefined) {
				delete process.env.OPENAI_API_KEY;
			} else {
				process.env.OPENAI_API_KEY = previousOpenAiKey;
			}
		});

		const prompts: string[] = [];
		const warnings: string[] = [];
		const errors: string[] = [];
		let runCount = 0;

		const transport: AgentTransport = {
			async *run(_messages, userMessage) {
				runCount += 1;
				prompts.push(extractText(userMessage));

				if (runCount === 1) {
					yield {
						type: "tool_execution_end",
						toolCallId: "tool-compact-next-iter",
						toolName: "compact",
						isError: false,
						result: {
							content: [{ type: "text", text: 'Compaction requested: "Continue mission compact-red"' }],
							details: {
								handoffType: "explicit",
								goal: "Continue mission compact-red",
								formattedMessage: "",
								parentSessionId: "",
								fileTokens: 0,
								keyFiles: [],
							},
						},
					};
				}

				if (runCount === 2) {
					writeMissionTasks(missionDir, "done");
				}

				yield { type: "agent_end", messages: [] };
			},
		};

		const agent = new Agent({
			transport,
			initialState: {
				model: getModel("openai", "gpt-4o-mini"),
				thinkingLevel: "medium",
			},
		});
		const renderer = createMissionRenderer({ configDir, agent, warnings, errors });
		renderer.buildSummaryCompactionDetails = async (goal) => ({
			handoffType: "explicit",
			goal,
			formattedMessage: "# Handoff: Continue mission compact-red",
			parentSessionId: "",
			fileTokens: 55,
			keyFiles: ["TASKS.json"],
		});
		cleanups.push(() => renderer.stop());

		await renderer.init();
		await renderer.handleEditorTextSubmission(`/mission-run ${missionDir}`, "by-end");
		await sleep(300);
		await agent.waitForIdle();

		expect(errors).toEqual([]);
		expect(warnings.join("\n")).toMatch(/done after 2 iterations/i);
		expect(runCount).toBe(2);
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toMatch(/Mission directory:/);
		expect(prompts[1]).toMatch(/Mission directory:/);
		expect(prompts.some((prompt) => prompt.includes(COMPACTION_CONTINUATION_PREFIX))).toBe(false);
	});
});
