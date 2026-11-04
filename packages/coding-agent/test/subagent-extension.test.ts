import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentExtension from "../examples/extensions/subagent/index.ts";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/index.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../src/core/tools/truncate.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const SUBAGENT_FIXTURE_PATH = fileURLToPath(new URL("./fixtures/subagent-child.mjs", import.meta.url));

const fixtureScenario = {
	error: "error",
	modelError: "model-error",
	signal: "signal",
	toolThenFinal: "tool-then-final",
	large: (name: string) => `large-${name}`,
	hold: (startsFile: string) => `hold:${startsFile}`,
	ignoreSigterm: (pidFile: string) => `ignore-sigterm:${pidFile}`,
	recordArgv: (outputFile: string) => `record-argv:${outputFile}`,
	recordInvocation: (outputFile: string) => `record-invocation:${outputFile}`,
	toolWait: (releaseFile: string) => `tool-wait:${releaseFile}`,
} as const;

type ChildStatus = "pending" | "running" | "completed" | "failed" | "aborted";

interface TestSingleResult {
	status: ChildStatus;
	messages: Message[];
	stderr: string;
	model?: string;
	errorMessage?: string;
	terminationSignal?: NodeJS.Signals;
}

interface TestSubagentDetails {
	results: TestSingleResult[];
}

function createProjectAgent(
	cwd: string,
	name = "worker",
	options: { model?: string; body?: string; raw?: string } = {},
): void {
	const dir = join(cwd, CONFIG_DIR_NAME, "agents");
	mkdirSync(dir, { recursive: true });
	const content =
		options.raw ??
		[
			"---",
			`name: ${name}`,
			`description: ${name} test agent`,
			...(options.model === undefined ? [] : [`model: ${options.model}`]),
			"---",
			options.body ?? "",
		].join("\n");
	writeFileSync(join(dir, `${name}.md`), content);
}

function readStartedPids(path: string): string[] {
	return readFileSync(path, "utf8").trim().split("\n");
}

function hasStartedPids(path: string, count: number): boolean {
	return existsSync(path) && readStartedPids(path).length === count;
}

function selectedModel(path: string): string | undefined {
	const args = JSON.parse(readFileSync(path, "utf8")) as string[];
	return args[args.indexOf("--model") + 1];
}

function detailsOf(result: AgentToolResult<unknown>): TestSubagentDetails {
	return result.details as TestSubagentDetails;
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function finalAssistantText(result: AgentToolResult<unknown>, resultIndex = 0): string {
	const messages = detailsOf(result).results[resultIndex]?.messages ?? [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		return message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function createTool(): ToolDefinition {
	let registered: ToolDefinition | undefined;
	const api = {
		on: vi.fn(),
		registerTool(tool: ToolDefinition) {
			registered = tool;
		},
	} as unknown as ExtensionAPI;
	subagentExtension(api);
	if (!registered) throw new Error("subagent extension did not register its tool");
	return registered;
}

function createContext(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		model: { provider: "test", id: "dispatch-alias" },
		thinkingLevel: "high",
		isProjectTrusted: () => false,
	} as unknown as ExtensionContext;
}

function createInteractiveContext(
	base: ExtensionContext,
	confirm: (title: string, message: string) => Promise<boolean>,
	trusted = false,
): ExtensionContext {
	return { ...base, hasUI: true, ui: { confirm }, isProjectTrusted: () => trusted } as unknown as ExtensionContext;
}

function singleTask(task: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		agent: "worker",
		task,
		agentScope: "project",
		confirmProjectAgents: false,
		...overrides,
	};
}

async function withFixtureInvocation<T>(run: () => Promise<T>): Promise<T> {
	// The example re-executes process.argv[1] as Pi. Point that invocation at
	// the deterministic fixture while retaining the real child_process.spawn.
	const originalScript = process.argv[1];
	process.argv[1] = SUBAGENT_FIXTURE_PATH;
	try {
		return await run();
	} finally {
		process.argv[1] = originalScript;
	}
}

function captureSettlement<T>(
	promise: Promise<T>,
): Promise<{ status: "fulfilled"; result: T } | { status: "rejected"; error: unknown }> {
	return promise.then(
		(result) => ({ status: "fulfilled" as const, result }),
		(error: unknown) => ({ status: "rejected" as const, error }),
	);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessExit(pid: number, timeoutMs = 1000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (isProcessAlive(pid) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return !isProcessAlive(pid);
}

function renderText(tool: ToolDefinition, result: AgentToolResult<unknown>, expanded = false): string {
	if (!tool.renderResult) throw new Error("subagent tool has no result renderer");
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as never;
	const component = tool.renderResult(result, { expanded, isPartial: false }, theme, {
		args: {},
		state: {},
		lastComponent: undefined,
		invalidate: () => {},
		toolCallId: "test",
		cwd: "/tmp",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: false,
		isError: false,
	});
	return component.render(160).join("\n");
}

describe("subagent example extension", () => {
	let tempDir: string;
	let tool: ToolDefinition;
	let ctx: ExtensionContext;
	const harnesses: Harness[] = [];

	function executeSubagent(
		params: Record<string, unknown>,
		options: {
			signal?: AbortSignal;
			onUpdate?: (result: AgentToolResult<unknown>) => void;
			context?: ExtensionContext;
		} = {},
	): Promise<AgentToolResult<unknown>> {
		return withFixtureInvocation(() =>
			tool.execute("test", params, options.signal, options.onUpdate, options.context ?? ctx),
		);
	}

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-subagent-test-"));
		createProjectAgent(tempDir);
		tool = createTool();
		ctx = createContext(tempDir);
	});

	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("child lifecycle", () => {
		it("keeps a child running across a tool-calling message until process close", async () => {
			const updates: AgentToolResult<unknown>[] = [];
			let releaseUpdate: (() => void) | undefined;
			const firstUpdate = new Promise<void>((resolve) => {
				releaseUpdate = resolve;
			});

			const execution = executeSubagent(singleTask(fixtureScenario.toolThenFinal), {
				onUpdate: (update) => {
					updates.push(update);
					releaseUpdate?.();
				},
			});

			await firstUpdate;
			const streamingStatus = detailsOf(updates[0]).results[0].status;
			const streamingRender = renderText(tool, updates[0]);
			const result = await execution;

			expect(streamingStatus).toBe("running");
			expect(streamingRender).toContain("running");
			expect(detailsOf(result).results[0].status).toBe("completed");
		});

		it("distinguishes pending tasks from four active workers", async () => {
			const updates: AgentToolResult<unknown>[] = [];
			const releaseFile = join(tempDir, "release-workers");
			const execution = executeSubagent(
				{
					tasks: Array.from({ length: 5 }, () => ({
						agent: "worker",
						task: fixtureScenario.toolWait(releaseFile),
					})),
					agentScope: "project",
					confirmProjectAgents: false,
				},
				{ onUpdate: (update) => updates.push(update) },
			);

			await waitFor(() => updates.length >= 4);
			const statuses = detailsOf(updates.at(-1)!).results.map((result) => result.status);
			writeFileSync(releaseFile, "release");
			await execution;

			expect(statuses.filter((status) => status === "running")).toHaveLength(4);
			expect(statuses.filter((status) => status === "pending")).toHaveLength(1);
		});

		it("treats signal termination as a failed child with a diagnostic", async () => {
			const result = await executeSubagent(singleTask(fixtureScenario.signal));

			const child = detailsOf(result).results[0];
			expect(child.status).toBe("failed");
			expect(child.terminationSignal).toBe("SIGTERM");
			expect(resultText(result)).toContain("SIGTERM");
		});

		it("preserves spawn errors for a nonexistent working directory", async () => {
			const result = await executeSubagent(
				singleTask("spawn-error", { cwd: join(tempDir, "missing-working-directory") }),
			);

			expect(detailsOf(result).results[0].status).toBe("failed");
			expect(resultText(result)).toMatch(/ENOENT|no such file or directory/i);
		});

		it("escalates SIGTERM to SIGKILL based on close state and preserves partial details", async () => {
			const pidFile = join(tempDir, "ignores-sigterm.pid");
			const controller = new AbortController();
			const execution = captureSettlement(
				executeSubagent(singleTask(fixtureScenario.ignoreSigterm(pidFile)), { signal: controller.signal }),
			);

			await waitFor(() => existsSync(pidFile));
			const pid = Number(readFileSync(pidFile, "utf8"));
			vi.useFakeTimers();
			controller.abort();
			await vi.advanceTimersByTimeAsync(5000);
			vi.useRealTimers();
			const exitedAfterEscalation = await waitForProcessExit(pid);
			if (!exitedAfterEscalation) process.kill(pid, "SIGKILL");
			const settled = await execution;

			expect(exitedAfterEscalation).toBe(true);
			expect(settled.status).toBe("fulfilled");
			if (settled.status === "fulfilled") {
				const child = detailsOf(settled.result).results[0];
				expect(child.status).toBe("aborted");
				expect(child.messages).toHaveLength(1);
			}
		});

		it("returns aborted task details when the signal is already aborted", async () => {
			const controller = new AbortController();
			controller.abort();
			vi.useFakeTimers();
			const settled = await captureSettlement(
				executeSubagent(
					{
						tasks: Array.from({ length: 5 }, () => ({
							agent: "worker",
							task: fixtureScenario.toolThenFinal,
						})),
						agentScope: "project",
						confirmProjectAgents: false,
					},
					{ signal: controller.signal },
				),
			);
			vi.useRealTimers();

			expect(settled.status).toBe("fulfilled");
			if (settled.status === "fulfilled") {
				expect(detailsOf(settled.result).results).toHaveLength(5);
				expect(detailsOf(settled.result).results.every((result) => result.status === "aborted")).toBe(true);
				expect(detailsOf(settled.result).results.every((result) => result.messages.length === 0)).toBe(true);
				expect(resultText(settled.result)).toContain("aborted");
			}
		});

		it("does not start queued work after aborting active workers", async () => {
			const controller = new AbortController();
			const startsFile = join(tempDir, "started-children.txt");
			const execution = captureSettlement(
				executeSubagent(
					{
						tasks: Array.from({ length: 5 }, () => ({
							agent: "worker",
							task: fixtureScenario.hold(startsFile),
						})),
						agentScope: "project",
						confirmProjectAgents: false,
					},
					{ signal: controller.signal },
				),
			);

			await waitFor(() => hasStartedPids(startsFile, 4));
			vi.useFakeTimers();
			controller.abort();
			const settled = await execution;
			vi.useRealTimers();

			expect(readStartedPids(startsFile)).toHaveLength(4);
			expect(settled.status).toBe("fulfilled");
			if (settled.status === "fulfilled") {
				expect(detailsOf(settled.result).results).toHaveLength(5);
				expect(detailsOf(settled.result).results.every((result) => result.status === "aborted")).toBe(true);
			}
		});
	});

	describe("runtime integration", () => {
		it("marks a failed subagent invocation as an error tool result while preserving details", async () => {
			const harness = await createHarness({ extensionFactories: [subagentExtension] });
			harnesses.push(harness);
			createProjectAgent(harness.tempDir);
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("subagent", {
						agent: "worker",
						task: fixtureScenario.error,
						agentScope: "project",
						confirmProjectAgents: false,
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);

			await withFixtureInvocation(() => harness.session.prompt("delegate"));

			const toolResult = harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "subagent",
			);
			expect(toolResult?.role).toBe("toolResult");
			if (toolResult?.role === "toolResult") {
				expect(toolResult.isError).toBe(true);
				expect((toolResult.details as TestSubagentDetails).results[0].errorMessage).toBe("provider evidence");
			}
		});

		it("marks invalid mode combinations as error tool results", async () => {
			const harness = await createHarness({ extensionFactories: [subagentExtension] });
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("subagent", {
						agent: "worker",
						task: "single",
						tasks: [{ agent: "worker", task: "parallel" }],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("delegate");

			const toolResult = harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "subagent",
			);
			expect(toolResult?.role === "toolResult" ? toolResult.isError : false).toBe(true);
		});
	});

	describe("task cwd agent discovery", () => {
		it("resolves a relative task cwd against the session cwd for discovery and execution", async () => {
			const startupRoot = join(tempDir, "startup-project");
			const sessionRoot = join(tempDir, "session-project");
			const startupChild = join(startupRoot, "child");
			const sessionChild = join(sessionRoot, "child");
			mkdirSync(startupChild, { recursive: true });
			mkdirSync(sessionChild, { recursive: true });
			createProjectAgent(startupChild, "worker", { model: "startup-model" });
			createProjectAgent(sessionChild, "worker", { model: "session-model" });
			const invocationFile = join(tempDir, "relative-cwd-invocation.json");
			const originalCwd = process.cwd();

			try {
				process.chdir(startupRoot);
				await executeSubagent(singleTask(fixtureScenario.recordInvocation(invocationFile), { cwd: "child" }), {
					context: createContext(sessionRoot),
				});
			} finally {
				process.chdir(originalCwd);
			}

			const invocation = JSON.parse(readFileSync(invocationFile, "utf8")) as { argv: string[]; cwd: string };
			expect(invocation.cwd).toBe(realpathSync(sessionChild));
			expect(invocation.argv[invocation.argv.indexOf("--model") + 1]).toBe("session-model");
		});

		it("uses and confirms the project agent from the child task cwd", async () => {
			const childCwd = join(tempDir, "confirmed-project");
			mkdirSync(childCwd);
			createProjectAgent(tempDir, "worker", { model: "root-model" });
			createProjectAgent(childCwd, "worker", { model: "child-model" });
			const argvFile = join(tempDir, "confirmed-child-argv.json");
			const confirm = vi.fn(async (_title: string, _message: string) => true);
			await executeSubagent(
				singleTask(fixtureScenario.recordArgv(argvFile), {
					cwd: childCwd,
					confirmProjectAgents: true,
				}),
				{ context: createInteractiveContext(ctx, confirm) },
			);

			expect.soft(selectedModel(argvFile)).toBe("child-model");
			expect(confirm).toHaveBeenCalledWith(
				"Run project-local agents?",
				expect.stringContaining(join(childCwd, CONFIG_DIR_NAME, "agents")),
			);
		});

		// Regression coverage for #8261 when a trusted session delegates into another project.
		it("confirms an external task cwd agent even when the session trust context reports trusted", async () => {
			const projectsRoot = join(tempDir, "projects");
			const sessionCwd = join(projectsRoot, "session-project");
			const externalCwd = join(projectsRoot, "external-project");
			mkdirSync(sessionCwd, { recursive: true });
			mkdirSync(externalCwd, { recursive: true });
			createProjectAgent(sessionCwd, "worker", { model: "session-model" });
			createProjectAgent(externalCwd, "worker", { model: "external-model" });
			const argvFile = join(tempDir, "external-child-argv.json");
			const confirm = vi.fn(async (_title: string, _message: string) => true);
			await executeSubagent(
				singleTask(fixtureScenario.recordArgv(argvFile), {
					cwd: externalCwd,
					confirmProjectAgents: true,
				}),
				{ context: createInteractiveContext(createContext(sessionCwd), confirm, true) },
			);

			expect.soft(selectedModel(argvFile)).toBe("external-model");
			expect(confirm).toHaveBeenCalledOnce();
			expect(confirm).toHaveBeenCalledWith(
				"Run project-local agents?",
				expect.stringContaining(join(externalCwd, CONFIG_DIR_NAME, "agents")),
			);
			expect(String(confirm.mock.calls[0][1])).not.toContain(join(sessionCwd, CONFIG_DIR_NAME, "agents"));
		});

		it("resolves and confirms each project-agent source for parallel task cwd values", async () => {
			const projectA = join(tempDir, "parallel-a");
			const projectB = join(tempDir, "parallel-b");
			mkdirSync(projectA);
			mkdirSync(projectB);
			createProjectAgent(projectA, "worker", { model: "model-a" });
			createProjectAgent(projectB, "worker", { model: "model-b" });
			const argvA1 = join(tempDir, "parallel-a1-argv.json");
			const argvA2 = join(tempDir, "parallel-a2-argv.json");
			const argvB = join(tempDir, "parallel-b-argv.json");
			const confirm = vi.fn(async (_title: string, _message: string) => true);
			await executeSubagent(
				{
					tasks: [
						{ agent: "worker", task: fixtureScenario.recordArgv(argvA1), cwd: projectA },
						{ agent: "worker", task: fixtureScenario.recordArgv(argvA2), cwd: projectA },
						{ agent: "worker", task: fixtureScenario.recordArgv(argvB), cwd: projectB },
					],
					agentScope: "project",
					confirmProjectAgents: true,
				},
				{ context: createInteractiveContext(ctx, confirm) },
			);

			expect.soft(selectedModel(argvA1)).toBe("model-a");
			expect.soft(selectedModel(argvA2)).toBe("model-a");
			expect.soft(selectedModel(argvB)).toBe("model-b");

			const confirmationText = confirm.mock.calls.map((call) => String(call[1])).join("\n");
			const sourceA = join(projectA, CONFIG_DIR_NAME, "agents");
			const sourceB = join(projectB, CONFIG_DIR_NAME, "agents");
			expect.soft(confirmationText.split(sourceA).length - 1).toBe(1);
			expect.soft(confirmationText.split(sourceB).length - 1).toBe(1);
		});
	});

	describe("model-facing output and rendering", () => {
		it.each([
			{ name: "single", params: singleTask(fixtureScenario.large("single")) },
			{
				name: "chain",
				params: {
					chain: [{ agent: "worker", task: fixtureScenario.large("chain") }],
					agentScope: "project",
					confirmProjectAgents: false,
				},
			},
		])("limits $name output while retaining complete details", async ({ params }) => {
			const result = await executeSubagent(params);

			const text = resultText(result);
			expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
			expect(text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
			expect(text).toMatch(/truncat/i);
			const fullText = finalAssistantText(result);
			expect(Buffer.byteLength(fullText, "utf8")).toBeGreaterThan(DEFAULT_MAX_BYTES);
			expect(fullText.split("\n").length).toBeGreaterThan(DEFAULT_MAX_LINES);
		});

		it("shows failure diagnostics in collapsed results", async () => {
			const result = await executeSubagent({
				chain: [{ agent: "worker", task: fixtureScenario.signal }],
				agentScope: "project",
				confirmProjectAgents: false,
			});

			expect(renderText(tool, result)).toContain("SIGTERM");
		});

		function runFailedChain(task: string = fixtureScenario.error): Promise<AgentToolResult<unknown>> {
			return executeSubagent({
				chain: [{ agent: "worker", task }],
				agentScope: "project",
				confirmProjectAgents: false,
			});
		}

		it("preserves provider errors, stderr, and assistant output as distinct evidence", async () => {
			const result = await runFailedChain();
			const child = detailsOf(result).results[0];
			expect.soft(child.errorMessage).toBe("provider evidence");
			expect.soft(child.stderr).toContain("stderr evidence");
			expect.soft(finalAssistantText(result)).toContain("assistant evidence");

			const expanded = renderText(tool, result, true);
			expect.soft(expanded).toContain("provider evidence");
			expect.soft(expanded).toContain("stderr evidence");
			expect.soft(expanded).toContain("assistant evidence");
		});

		it("renders zero-exit model errors as failed chain steps", async () => {
			expect(renderText(tool, await runFailedChain(fixtureScenario.modelError))).toContain("0/1 steps");
		});
	});
});
