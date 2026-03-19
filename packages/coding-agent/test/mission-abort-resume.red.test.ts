import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTransport } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

type MissionRuntimeRenderer = {
	init(): Promise<void>;
	stop(): void;
	showWarning(message: string): void;
	handleEditorTextSubmission(text: string, kind: "by-end" | "next"): Promise<void>;
	editor: { handleInput(data: string): void };
	onInputCallback?: (text: string) => void;
};

function makeTodoMissionDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "mu-mission-abort-resume-red-"));
	writeFileSync(join(dir, "SPEC.md"), "# Goal\nShip /mission-run\n");
	writeFileSync(join(dir, "PROGRESS.md"), "# Progress\n\n## Status\n- not done\n");
	writeFileSync(join(dir, "RUNBOOK.md"), "# Runbook\n\n1. Work one task at a time.\n");
	writeFileSync(
		join(dir, "TASKS.json"),
		JSON.stringify(
			{
				tasks: [{ id: "baseline", title: "Still todo", status: "todo", validation: [], notes: "" }],
			},
			null,
			2,
		),
	);
	return {
		dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("mission abort resume semantics (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			const cleanup = cleanups.pop();
			cleanup?.();
		}
	});

	it("keeps an immediate by-end follow-up in the same mission iteration after abort", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-mission-abort-resume-config-"));
		cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));

		const { dir, cleanup } = makeTodoMissionDir();
		cleanups.push(cleanup);

		const previousOpenAiKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-openai-key";
		cleanups.push(() => {
			if (previousOpenAiKey === undefined) {
				delete process.env.OPENAI_API_KEY;
			} else {
				process.env.OPENAI_API_KEY = previousOpenAiKey;
			}
		});

		let runCalls = 0;
		let resolveFirstIterationStarted: (() => void) | null = null;
		const firstIterationStarted = new Promise<void>((resolve) => {
			resolveFirstIterationStarted = resolve;
		});

		const transport: AgentTransport = {
			async *run(_messages, userMessage, _config, signal) {
				runCalls += 1;
				if (runCalls === 1) {
					resolveFirstIterationStarted?.();
					await new Promise<void>((done) => {
						signal?.addEventListener("abort", () => done(), { once: true });
					});
				} else if (runCalls === 2) {
					const text = Array.isArray(userMessage.content)
						? userMessage.content
								.filter(
									(content): content is { type: "text"; text: string } =>
										typeof content === "object" &&
										content !== null &&
										"type" in content &&
										content.type === "text" &&
										"text" in content &&
										typeof content.text === "string",
								)
								.map((content) => content.text)
								.join("\n")
						: String(userMessage.content);

					expect(text).toContain("please continue within the same mission turn");
					writeFileSync(
						join(dir, "TASKS.json"),
						JSON.stringify(
							{
								tasks: [{ id: "baseline", title: "Still todo", status: "done", validation: [], notes: "" }],
							},
							null,
							2,
						),
					);
				}
				yield* [];
			},
		};

		const agent = new Agent({
			transport,
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
				getSessionId: () => "mission-abort-resume-red",
			} as never,
			new SettingsManager(configDir),
			{
				listCommands: () => [],
				getCommand: () => undefined,
				applyInputHooks: async (text: string) => ({ handled: false, text }),
				composeToolResultTransformer: <T>(base: T) => base,
			} as never,
			{} as never,
			"0.0.0",
		) as unknown as MissionRuntimeRenderer;

		await renderer.init();
		cleanups.push(() => renderer.stop());

		const warnings: string[] = [];
		renderer.showWarning = (message: string) => {
			warnings.push(message);
		};

		const fallbackSubmissions: string[] = [];
		renderer.onInputCallback = (text: string) => {
			fallbackSubmissions.push(text);
			renderer.onInputCallback = undefined;
		};

		const missionRunPromise = renderer.handleEditorTextSubmission(`/mission-run ${dir}`, "by-end");
		await firstIterationStarted;
		renderer.editor.handleInput("\x1b");
		await renderer.handleEditorTextSubmission("please continue within the same mission turn", "by-end");
		await missionRunPromise;
		await agent.waitForIdle();

		expect(fallbackSubmissions).toEqual([]);
		expect(runCalls).toBe(2);
		expect(warnings.join("\n")).toMatch(/done after 1 iteration/i);
		expect(warnings.join("\n")).not.toMatch(/stopped after 1 iteration/i);
	});

	it("keeps an immediate queued-next follow-up in the same mission iteration after abort", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-mission-abort-resume-config-"));
		cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));

		const { dir, cleanup } = makeTodoMissionDir();
		cleanups.push(cleanup);

		const previousOpenAiKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-openai-key";
		cleanups.push(() => {
			if (previousOpenAiKey === undefined) {
				delete process.env.OPENAI_API_KEY;
			} else {
				process.env.OPENAI_API_KEY = previousOpenAiKey;
			}
		});

		let runCalls = 0;
		let resolveFirstIterationStarted: (() => void) | null = null;
		const firstIterationStarted = new Promise<void>((resolve) => {
			resolveFirstIterationStarted = resolve;
		});

		const transport: AgentTransport = {
			async *run(_messages, userMessage, _config, signal) {
				runCalls += 1;
				if (runCalls === 1) {
					resolveFirstIterationStarted?.();
					await new Promise<void>((done) => {
						signal?.addEventListener("abort", () => done(), { once: true });
					});
				} else if (runCalls === 2) {
					const text = Array.isArray(userMessage.content)
						? userMessage.content
								.filter(
									(content): content is { type: "text"; text: string } =>
										typeof content === "object" &&
										content !== null &&
										"type" in content &&
										content.type === "text" &&
										"text" in content &&
										typeof content.text === "string",
								)
								.map((content) => content.text)
								.join("\n")
						: String(userMessage.content);

					expect(text).toContain("please continue right now");
					writeFileSync(
						join(dir, "TASKS.json"),
						JSON.stringify(
							{
								tasks: [{ id: "baseline", title: "Still todo", status: "done", validation: [], notes: "" }],
							},
							null,
							2,
						),
					);
				}
				yield* [];
			},
		};

		const agent = new Agent({
			transport,
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
				getSessionId: () => "mission-abort-resume-red",
			} as never,
			new SettingsManager(configDir),
			{
				listCommands: () => [],
				getCommand: () => undefined,
				applyInputHooks: async (text: string) => ({ handled: false, text }),
				composeToolResultTransformer: <T>(base: T) => base,
			} as never,
			{} as never,
			"0.0.0",
		) as unknown as MissionRuntimeRenderer;

		await renderer.init();
		cleanups.push(() => renderer.stop());

		const warnings: string[] = [];
		renderer.showWarning = (message: string) => {
			warnings.push(message);
		};

		const fallbackSubmissions: string[] = [];
		renderer.onInputCallback = (text: string) => {
			fallbackSubmissions.push(text);
			renderer.onInputCallback = undefined;
		};

		const missionRunPromise = renderer.handleEditorTextSubmission(`/mission-run ${dir}`, "by-end");
		await firstIterationStarted;
		renderer.editor.handleInput("\x1b");
		await renderer.handleEditorTextSubmission("please continue right now", "next");
		await missionRunPromise;
		await agent.waitForIdle();

		expect(fallbackSubmissions).toEqual([]);
		expect(runCalls).toBe(2);
		expect(warnings.join("\n")).toMatch(/done after 1 iteration/i);
		expect(warnings.join("\n")).not.toMatch(/stopped after 1 iteration/i);
	});
});
