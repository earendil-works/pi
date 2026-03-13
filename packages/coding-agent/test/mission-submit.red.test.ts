import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, type AgentTransport } from "@kennyfrc/mu-agent-core";
import { getModel, type Model } from "@kennyfrc/mu-ai";
import stripAnsi from "strip-ansi";
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
	getComposerMetaLabel(): string;
	editor: { handleInput(data: string): void };
};

function extractTextContent(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (!Array.isArray(value)) {
		return "";
	}
	return value
		.filter((content): content is { type: "text"; text: string } => {
			return (
				typeof content === "object" &&
				content !== null &&
				"type" in content &&
				content.type === "text" &&
				"text" in content &&
				typeof content.text === "string"
			);
		})
		.map((content) => content.text)
		.join("\n");
}

function makeMissionDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "mu-mission-submit-red-"));
	writeFileSync(join(dir, "SPEC.md"), "# Goal\nShip /mission-run\n");
	writeFileSync(join(dir, "PROGRESS.md"), "# Progress\n\n## Status\n- all done\n");
	writeFileSync(join(dir, "RUNBOOK.md"), "# Runbook\n\n1. Work one task at a time.\n");
	writeFileSync(
		join(dir, "TASKS.json"),
		JSON.stringify(
			{
				tasks: [{ id: "baseline", title: "Done already", status: "done", validation: [], notes: "" }],
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

function makeTodoMissionDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "mu-mission-submit-todo-red-"));
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

describe("/mission-run submission (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("handles a completed mission as a built-in command instead of falling through to normal chat submission", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-mission-submit-config-"));
		cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));

		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);

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
				appendContextCompaction: () => {},
				loadTitle: () => null,
				getSessionId: () => "mission-submit-red",
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
		) as unknown as MissionRenderer;

		await renderer.init();
		cleanups.push(() => renderer.stop());

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

		await renderer.handleEditorTextSubmission(`/mission-run ${dir}`, "by-end");

		expect(errors).toEqual([]);
		expect(warnings.join("\n")).toMatch(/mission.*done/i);
		const footerLabel = stripAnsi(renderer.getComposerMetaLabel());
		expect(footerLabel).toContain(`mission ${dir.split("/").at(-1)}`);
		expect(footerLabel).toContain("iter 0");
		expect(footerLabel).toContain("done");
		expect(footerLabel).toContain("1/1 done");
	});

	it("resolves @mission-name to devdocs/missions/<mission-name>", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-mission-submit-config-"));
		cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));

		const missionName = `mu-mission-tag-red-${Date.now()}`;
		const missionDir = resolve(process.cwd(), "..", "..", "devdocs", "missions", missionName);
		mkdirSync(missionDir, { recursive: true });
		writeFileSync(join(missionDir, "SPEC.md"), "# Goal\nShip /mission-run\n", { flag: "wx" });
		writeFileSync(join(missionDir, "PROGRESS.md"), "# Progress\n\n## Status\n- all done\n", { flag: "wx" });
		writeFileSync(join(missionDir, "RUNBOOK.md"), "# Runbook\n\n1. Work one task at a time.\n", { flag: "wx" });
		writeFileSync(
			join(missionDir, "TASKS.json"),
			JSON.stringify(
				{
					tasks: [{ id: "baseline", title: "Done already", status: "done", validation: [], notes: "" }],
				},
				null,
				2,
			),
			{ flag: "wx" },
		);
		cleanups.push(() => rmSync(missionDir, { recursive: true, force: true }));

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
				appendContextCompaction: () => {},
				loadTitle: () => null,
				getSessionId: () => "mission-submit-red",
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
		) as unknown as MissionRenderer;

		await renderer.init();
		cleanups.push(() => renderer.stop());

		const warnings: string[] = [];
		const originalShowWarning = renderer.showWarning.bind(renderer);
		renderer.showWarning = (message: string) => {
			warnings.push(message);
			originalShowWarning(message);
		};

		await renderer.handleEditorTextSubmission(`/mission-run @${missionName}`, "by-end");

		expect(warnings.join("\n")).toMatch(/already done/i);
		const footerLabel = stripAnsi(renderer.getComposerMetaLabel());
		expect(footerLabel).toContain(`mission ${missionName}`);
		expect(footerLabel).toContain("done");
	});

	it("fails fast on an unfinished mission when no API key is configured instead of entering the loop", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-mission-submit-config-"));
		cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));

		const { dir, cleanup } = makeTodoMissionDir();
		cleanups.push(cleanup);

		const syntheticNoKeyModel: Model<"openai-completions"> = {
			id: "mission-no-key",
			name: "Mission No Key",
			api: "openai-completions",
			provider: "mission-test-provider",
			baseUrl: "https://example.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 4096,
		};

		let runCalls = 0;
		const agent = new Agent({
			transport: {
				async *run() {
					runCalls += 1;
					yield* [];
				},
			} as never,
			initialState: {
				model: syntheticNoKeyModel,
				thinkingLevel: "medium",
			},
		});

		const renderer = new TuiRenderer(
			agent,
			{
				appendContextCompaction: () => {},
				loadTitle: () => null,
				getSessionId: () => "mission-submit-red",
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
		) as unknown as MissionRenderer;

		await renderer.init();
		cleanups.push(() => renderer.stop());

		const errors: string[] = [];
		const originalShowError = renderer.showError.bind(renderer);
		renderer.showError = (message: string) => {
			errors.push(message);
			originalShowError(message);
		};

		await renderer.handleEditorTextSubmission(`/mission-run ${dir}`, "by-end");

		expect(runCalls).toBe(0);
		expect(errors.join("\n")).toMatch(/no api key/i);
		const footerLabel = stripAnsi(renderer.getComposerMetaLabel());
		expect(footerLabel).toContain(`mission ${dir.split("/").at(-1)}`);
		expect(footerLabel).toContain("iter 0");
		expect(footerLabel).toContain("blocked");
		expect(footerLabel).toContain("0/1 done");
		expect(footerLabel).toContain("task baseline: Still todo");
	});

	it("shows running mission footer details during the loop and final done counts after one iteration", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-mission-submit-config-"));
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

		let renderer: MissionRenderer;
		const runningLabels: string[] = [];
		const prePromptHistorySnapshots: string[] = [];
		let runCalls = 0;
		const transport: AgentTransport = {
			async *run(messages) {
				runCalls += 1;
				runningLabels.push(stripAnsi(renderer.getComposerMetaLabel()));
				prePromptHistorySnapshots.push(
					messages.map((message) => extractTextContent(message.content)).join("\n\n---\n\n"),
				);
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

		renderer = new TuiRenderer(
			agent,
			{
				appendContextCompaction: () => {},
				loadTitle: () => null,
				getSessionId: () => "mission-submit-red",
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
		) as unknown as MissionRenderer;

		await renderer.init();
		cleanups.push(() => renderer.stop());

		const warnings: string[] = [];
		const originalShowWarning = renderer.showWarning.bind(renderer);
		renderer.showWarning = (message: string) => {
			warnings.push(message);
			originalShowWarning(message);
		};

		await renderer.handleEditorTextSubmission(`/mission-run ${dir}`, "by-end");

		expect(runCalls).toBe(1);
		expect(prePromptHistorySnapshots[0]).toContain("Use this compacted checkpoint as the active context");
		expect(prePromptHistorySnapshots[0]).toContain("Continue mission");
		expect(runningLabels[0]).toContain(`mission ${dir.split("/").at(-1)}`);
		expect(runningLabels[0]).toContain("iter 1");
		expect(runningLabels[0]).toContain("running");
		expect(runningLabels[0]).toContain("0/1 done");
		expect(runningLabels[0]).toContain("task baseline: Still todo");
		expect(warnings.join("\n")).toMatch(/done after 1 iteration/i);

		const footerLabel = stripAnsi(renderer.getComposerMetaLabel());
		expect(footerLabel).toContain(`mission ${dir.split("/").at(-1)}`);
		expect(footerLabel).toContain("iter 1");
		expect(footerLabel).toContain("done");
		expect(footerLabel).toContain("1/1 done");
		expect(footerLabel).not.toContain("task baseline");
	});

	it("keeps the working footer spinner and timer advancing during a slow mission iteration", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-mission-submit-config-"));
		cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));

		const dir = mkdtempSync(join(tmpdir(), "mu-ms-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
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

		const previousOpenAiKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-openai-key";
		cleanups.push(() => {
			if (previousOpenAiKey === undefined) {
				delete process.env.OPENAI_API_KEY;
			} else {
				process.env.OPENAI_API_KEY = previousOpenAiKey;
			}
		});

		let renderer: MissionRenderer;
		const transport: AgentTransport = {
			async *run() {
				await new Promise((resolve) => setTimeout(resolve, 1_350));
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

		renderer = new TuiRenderer(
			agent,
			{
				appendContextCompaction: () => {},
				loadTitle: () => null,
				getSessionId: () => "mission-submit-red",
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
		) as unknown as MissionRenderer;

		await renderer.init();
		cleanups.push(() => renderer.stop());

		const submissionPromise = renderer.handleEditorTextSubmission(`/mission-run ${dir}`, "by-end");

		await new Promise((resolve) => setTimeout(resolve, 150));
		const earlyFooter = stripAnsi(
			(renderer as unknown as { footer: { render: (width: number) => string[] } }).footer.render(120).join("\n"),
		);

		await new Promise((resolve) => setTimeout(resolve, 1_100));
		const laterFooter = stripAnsi(
			(renderer as unknown as { footer: { render: (width: number) => string[] } }).footer.render(120).join("\n"),
		);

		await submissionPromise;

		expect(earlyFooter).toContain("Working");
		expect(laterFooter).toContain("Working");
		expect(earlyFooter).toContain("0s");
		expect(laterFooter).toContain("1s");
		expect(laterFooter).not.toBe(earlyFooter);
	});

	it("stops the mission loop when escape is pressed during a running iteration", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-mission-submit-config-"));
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
		const transport: AgentTransport = {
			async *run(_messages, _userMessage, _config, signal) {
				runCalls += 1;
				await new Promise<void>((resolve) => {
					if (signal?.aborted) {
						resolve();
						return;
					}
					signal?.addEventListener("abort", () => resolve(), { once: true });
				});
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
				getSessionId: () => "mission-submit-red",
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
		) as unknown as MissionRenderer;

		await renderer.init();
		cleanups.push(() => renderer.stop());

		const warnings: string[] = [];
		renderer.showWarning = (message: string) => {
			warnings.push(message);
		};

		const submissionPromise = renderer.handleEditorTextSubmission(`/mission-run ${dir}`, "by-end");
		await new Promise((resolve) => setTimeout(resolve, 50));
		renderer.editor.handleInput("\x1b");
		await submissionPromise;

		expect(runCalls).toBe(1);
		expect(warnings.join("\n")).toMatch(/stopped/i);
		const footerLabel = stripAnsi(renderer.getComposerMetaLabel());
		expect(footerLabel).toContain(`mission ${dir.split("/").at(-1)}`);
		expect(footerLabel).toContain("stopped");
		expect(footerLabel).toContain("0/1 done");
	});

	it("compacts before every mission iteration, not just the first one", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-mission-submit-config-"));
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

		let renderer: MissionRenderer;
		const prePromptHistorySnapshots: string[] = [];
		let runCalls = 0;
		const transport: AgentTransport = {
			async *run(messages) {
				runCalls += 1;
				prePromptHistorySnapshots.push(
					messages.map((message) => extractTextContent(message.content)).join("\n\n---\n\n"),
				);

				if (runCalls === 1) {
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
				} else {
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

		renderer = new TuiRenderer(
			agent,
			{
				appendContextCompaction: () => {},
				loadTitle: () => null,
				getSessionId: () => "mission-submit-red",
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
		) as unknown as MissionRenderer;

		await renderer.init();
		cleanups.push(() => renderer.stop());

		await renderer.handleEditorTextSubmission(`/mission-run ${dir}`, "by-end");

		expect(runCalls).toBe(2);
		expect(prePromptHistorySnapshots).toHaveLength(2);
		for (const snapshot of prePromptHistorySnapshots) {
			expect(snapshot).toContain("Use this compacted checkpoint as the active context");
			expect(snapshot).toContain("Continue mission");
		}

		const footerLabel = stripAnsi(renderer.getComposerMetaLabel());
		expect(footerLabel).toContain("iter 2");
		expect(footerLabel).toContain("done");
	});
});
