import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type ToolResultMessage,
	Type,
} from "@earendil-works/pi-ai";
import {
	type EntryRecord,
	type Harness,
	LiveDoc,
	PostToolsTask,
	type Registration,
	type TaskId,
	type ToolRegistration,
	ToolResultEntry,
	ToolTask,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionEnv } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { createBashTool } from "../src/tools/index.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, waitFor } from "./chat-support.ts";
import { context } from "./session-support.ts";
import { aborted, deferred } from "./task-support.ts";

const directories = new Set<string>();

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-tools-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

async function open(path: string, setup: ChatSetup, env?: ExecutionEnv) {
	const opened = await openChat(await openNodeSqliteStorage(path), setup, env === undefined ? {} : { env });
	opened.harness.resume();
	return opened;
}

function tool(
	name: string,
	execute: ToolRegistration["execute"],
	extra: Partial<ToolRegistration> = {},
): ToolRegistration {
	return { name, description: name, parameters: Type.Object({}), execute, ...extra };
}

function call(name: string, id = "c1"): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall(name, {}, { id })], { stopReason: "toolUse" });
}

const DONE = fauxAssistantMessage([fauxText("done")]);

function results(entries: readonly EntryRecord[]): ToolResultMessage[] {
	return entries.filter((entry) => ToolResultEntry.is(entry)).map((entry) => entry.model![0] as ToolResultMessage);
}

function text(message: ToolResultMessage | undefined): string {
	return (message?.content ?? []).map((item) => (item.type === "text" ? item.text : "")).join("|");
}

async function toolTaskId(harness: Harness): Promise<TaskId> {
	let id: TaskId | undefined;
	await waitFor(async () => {
		id = (await harness.snapshot(LiveDoc, 1 as never, context))?.tools?.[0]?.taskId;
		return id !== undefined;
	});
	return id!;
}

/**
 * A tool that writes output, then blocks until its invocation is cancelled the first `blocking` times it runs.
 * `started` resolves once the output is durable.
 */
function blockingTool(name: string, extra: Partial<ToolRegistration> = {}) {
	const started = deferred();
	const state = { runs: 0, blocking: 1 };
	const registration = tool(
		name,
		async (_args, api, callContext) => {
			state.runs++;
			api.output(`run ${state.runs}\n`);
			await api.details({ run: state.runs }, callContext);
			if (state.runs <= state.blocking) {
				started.resolve();
				await aborted(callContext.abortSignal!);
			}
			return {};
		},
		extra,
	);
	return { registration, started, state };
}

describe("tool recovery", () => {
	it("answers an unsafe tool interrupted after intent with its durable partial output", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const { registration, started, state } = blockingTool("work");
		setup.registry.tools.add(registration);
		setup.faux.setResponses([call("work"), DONE]);
		let opened = await open(path, setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await started.promise;
		const taskId = await toolTaskId(opened.harness);
		await opened.harness.close(context);

		opened = await open(path, setup);
		expect((await opened.harness.getTask(taskId, context))?.state).toMatchObject({
			checkpoint: { phase: "execute", arguments: {}, replay: "unsafe" },
		});
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		expect(state.runs).toBe(1);
		const [result] = results(await allEntries(opened.root));
		expect(result).toMatchObject({ isError: true, details: { run: 1 } });
		expect(text(result)).toBe(
			"run 1\n|<harness>\n[error] Tool work was interrupted and may have partially run\n</harness>",
		);
		expect(await opened.harness.snapshot(LiveDoc, opened.root.id, context)).toEqual({});
		await opened.harness.close(context);
	});

	it("reruns a tool only when both the stored and the current replay policy are safe", async () => {
		const cases: [stored: "safe" | "unsafe", current: "safe" | "unsafe", reruns: boolean][] = [
			["safe", "safe", true],
			["safe", "unsafe", false],
			["unsafe", "safe", false],
		];
		for (const [stored, current, reruns] of cases) {
			const path = await sqlitePath();
			const setup = chatSetup();
			const blocking = blockingTool("work", { replay: stored });
			const registration: Registration = setup.registry.tools.add(blocking.registration);
			setup.faux.setResponses([call("work"), DONE]);
			let opened = await open(path, setup);
			const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
			await blocking.started.promise;
			await opened.harness.close(context);

			registration.dispose();
			setup.registry.tools.add({ ...blocking.registration, replay: current });
			opened = await open(path, setup);
			expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
			const [result] = results(await allEntries(opened.root));
			expect(blocking.state.runs).toBe(reruns ? 2 : 1);
			expect(result!.isError).toBe(!reruns);
			if (reruns) expect(text(result)).toBe("run 2\n");
			await opened.harness.close(context);
		}
	});

	it("reruns beforeTool when interrupted before intent, and executes once", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		let runs = 0;
		setup.registry.tools.add(
			tool("work", async () => {
				runs++;
				return { content: [] };
			}),
		);
		const reached = deferred();
		let asked = 0;
		const decisions: string[] = [];
		setup.registry.hooks.add(ToolTask, {
			beforeTool: async (_call, api, callContext) => {
				asked++;
				// A durable first-writer-wins decision survives the rerun.
				decisions.push(await api.memo("test:decision", `attempt ${asked}`, callContext));
				if (asked === 1) {
					reached.resolve();
					await aborted(callContext.abortSignal!);
				}
				return undefined;
			},
		});
		setup.faux.setResponses([call("work"), DONE]);
		let opened = await open(path, setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await reached.promise;
		await opened.harness.close(context);

		opened = await open(path, setup);
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		expect([asked, runs]).toEqual([2, 1]);
		expect(decisions).toEqual(["attempt 1", "attempt 1"]);
		await opened.harness.close(context);
	});

	it("reruns post-tools interrupted before its commit", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		setup.registry.tools.add(tool("work", async () => ({ content: [] })));
		const reached = deferred();
		let observed = 0;
		setup.registry.hooks.add(PostToolsTask, {
			afterTools: async (_assistant, _results, _api, callContext) => {
				observed++;
				if (observed === 1) {
					reached.resolve();
					await aborted(callContext.abortSignal!);
				}
			},
		});
		setup.faux.setResponses([call("work"), DONE]);
		let opened = await open(path, setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await reached.promise;
		await opened.harness.close(context);

		opened = await open(path, setup);
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		expect(observed).toBe(2);
		expect((await allEntries(opened.root)).map((entry) => entry.kind)).toEqual([
			"pi.user",
			"pi.system",
			"pi.assistant",
			"pi.tool-result",
			"pi.assistant",
		]);
		await opened.harness.close(context);
	});

	it("answers an aborted tool with its partial output and continues the run", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const { registration, started } = blockingTool("work");
		setup.registry.tools.add(registration);
		setup.faux.setResponses([call("work"), DONE]);
		const opened = await open(path, setup);
		const submission = await opened.root.submit({ type: "input", content: "go" }, context);
		await started.promise;
		const taskId = await toolTaskId(opened.harness);
		expect(await opened.harness.abortTask(taskId, context)).toBe("marked");
		expect((await opened.harness.waitForTask(taskId, context)).state.outcome).toMatchObject({
			status: "aborted",
			result: { entryId: expect.any(Number) },
		});
		expect((await submission.wait(context)).status).toBe("done");
		const [result] = results(await allEntries(opened.root));
		expect(text(result)).toBe("run 1\n|<harness>\n[error] Tool work was aborted\n</harness>");
		await opened.harness.close(context);
	});

	it("lets context derivation answer a faulted tool and continues the run", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		// A result that is not strict JSON makes the result commit throw, so the scheduler faults the task.
		setup.registry.tools.add(
			tool("bad", async () => ({ content: [], details: { fn: (() => 1) as unknown as JsonValue } })),
		);
		const requests: string[] = [];
		setup.faux.setResponses([
			call("bad"),
			(request) => {
				const result = request.messages.find((message) => message.role === "toolResult");
				requests.push(result?.role === "toolResult" ? text(result) : "none");
				return DONE;
			},
		]);
		const opened = await open(path, setup);
		const settled = await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(settled.status).toBe("done");
		expect(results(await allEntries(opened.root))).toEqual([]);
		expect(requests).toEqual(["Tool result unavailable: history ends before this call completed."]);
		const tasks = await opened.harness.commit((tx) => tx.scanTasks({ conversationId: opened.root.id }, 20), context);
		const faulted = tasks.items.find((task) => task.kind === "pi.tool")!;
		expect(faulted.state).toMatchObject({ status: "terminal", outcome: { status: "faulted" } });
		await opened.harness.close(context);
	});

	it("answers a real bash command interrupted by close and reopen, then finishes the run", async () => {
		const path = await sqlitePath();
		const env = new NodeExecutionEnv({ cwd: dirname(path) });
		const setup = chatSetup();
		setup.registry.tools.add(createBashTool());
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo started; sleep 30" }, { id: "b" })], {
				stopReason: "toolUse",
			}),
			DONE,
		]);
		let opened = await open(path, setup, env);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await waitFor(async () => {
			const slot = (await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.tools?.[0];
			return slot?.output === "started\n";
		});
		await opened.harness.close(context);

		opened = await open(path, setup, env);
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		const [result] = results(await allEntries(opened.root));
		expect(text(result)).toBe(
			"started\n|<harness>\n[error] Tool bash was interrupted and may have partially run\n</harness>",
		);
		await opened.harness.close(context);
	});

	it("clears the interrupted attempt's progress before a safe rerun", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const started = [deferred(), deferred()];
		let runs = 0;
		setup.registry.tools.add(
			tool(
				"work",
				async (_args, api, callContext) => {
					const run = runs++;
					if (run === 0) {
						api.diagnostic({ severity: "info", message: "first a" });
						api.diagnostic({ severity: "info", message: "first b" });
						await api.details({ run: 1, extra: true }, callContext);
					} else {
						api.diagnostic({ severity: "info", message: "second" });
						await api.details({ run: 2 }, callContext);
					}
					started[run]!.resolve();
					await aborted(callContext.abortSignal!);
					return {};
				},
				{ replay: "safe" },
			),
		);
		setup.faux.setResponses([call("work"), DONE]);
		let opened = await open(path, setup);
		await opened.root.submit({ type: "input", content: "go" }, context);
		await started[0]!.promise;
		await opened.harness.close(context);

		opened = await open(path, setup);
		await started[1]!.promise;
		const slot = (await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.tools?.[0];
		expect(slot?.diagnostics).toEqual([{ severity: "info", message: "second" }]);
		expect(slot?.details).toEqual({ run: 2 });
		await opened.harness.close(context);
	});
});
