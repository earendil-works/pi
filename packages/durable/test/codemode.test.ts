import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { type AssistantMessage, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { CodemodeSandbox, loadCodemodeWasm } from "@earendil-works/pi-codemode";
import {
	defineExtension,
	defineSignal,
	defineTool,
	type Harness,
	type TaskId,
	type ToolRegistration,
	ToolResultEntry,
	ToolTask,
	type ToolTaskInput,
} from "@earendil-works/pi-durable";
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import { afterEach, describe, expect, it } from "vitest";
import { CodemodeSavedDoc } from "../src/codemode/call.ts";
import {
	type CodemodeGlobal,
	CodemodeRunDoc,
	type CodemodeToolDetails,
	createCodemodeTool,
} from "../src/codemode/codemode.ts";
import { defineDoc } from "../src/documents.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { createReadTool } from "../src/tools/read.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, waitFor } from "./chat-support.ts";
import { addHooks, addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { aborted, type Deferred, deferred } from "./task-support.ts";

const Parameters = obj({ text: opt(str()), id: opt(num()) });

function tool(
	name: string,
	execute: ToolRegistration<typeof Parameters>["execute"],
	replay: "safe" | "unsafe" = "unsafe",
) {
	return defineTool({ name, description: name, parameters: Parameters, execute, replay });
}

const DONE = fauxAssistantMessage([fauxText("done")]);

/** The journal of the format before djs (code mode version 2), which a store from then may still hold. */
const JournalDoc = defineDoc<{ entries: JsonValue[] }>({
	kind: "pi.codemode.journal",
	version: 1,
	scope: "task",
	initial: () => ({ entries: [] }),
	checkpointWhen: () => false,
});

const wasm = await loadCodemodeWasm();

function script(code: string): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "s1" })], { stopReason: "toolUse" });
}

const directories = new Set<string>();
afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-codemode-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

/**
 * A chat with the code mode tool and test tools:
 * - `echo` returns `echo <text>` and counts its runs by text;
 * - `hold` (replay-safe) waits for `holds.gate` while `holds.block` is set, then returns `held <id>`;
 * - `slow` returns `slow <id>` once `slows.release(id)` was called.
 */
function codemodeChat(globals: CodemodeGlobal[] = [], parkAfterMs?: number, fuel?: number) {
	const setup = chatSetup();
	const sandbox = new CodemodeSandbox({
		wasm,
		memoryLimitBytes: 64 * 1024 * 1024,
		...(fuel === undefined ? {} : { fuel }),
	});
	// VMs started: a new run or a resumed dump.
	const vm = { starts: 0 };
	const begin = sandbox.begin.bind(sandbox);
	const resume = sandbox.resume.bind(sandbox);
	sandbox.begin = (code, scope) => {
		vm.starts++;
		return begin(code, scope);
	};
	sandbox.resume = (scope, saved) => {
		vm.starts++;
		return resume(scope, saved);
	};
	addTool(
		setup.registry,
		createCodemodeTool({ sandbox, globals, ...(parkAfterMs === undefined ? {} : { parkAfterMs }) }),
	);
	const echo = new Map<string, number>();
	addTool(
		setup.registry,
		tool("echo", async (args) => {
			echo.set(args.text ?? "", (echo.get(args.text ?? "") ?? 0) + 1);
			return { output: [{ type: "text", text: `echo ${args.text ?? ""}` }] };
		}),
	);
	const holds = { block: true, reached: deferred(), runs: 0 };
	addTool(
		setup.registry,
		tool(
			"hold",
			async (args, _api, callContext) => {
				holds.runs++;
				if (holds.block) {
					holds.reached.resolve();
					await aborted(callContext.abortSignal!);
				}
				return { output: [{ type: "text", text: `held ${args.id ?? ""}` }] };
			},
			"safe",
		),
	);
	const pauses = { block: true, reached: deferred() };
	addTool(
		setup.registry,
		tool(
			"pause",
			async (_args, _api, callContext) => {
				if (pauses.block) {
					pauses.reached.resolve();
					await aborted(callContext.abortSignal!);
				}
				return { output: [{ type: "text", text: "paused" }] };
			},
			"safe",
		),
	);
	const gates = new Map<number, Deferred>();
	const done = new Map<number, Deferred>();
	const finished: number[] = [];
	const once = (map: Map<number, Deferred>, id: number) => {
		const found = map.get(id) ?? deferred();
		map.set(id, found);
		return found;
	};
	const slows = {
		finished,
		gate: (id: number) => once(gates, id),
		release: (id: number) => slows.gate(id).resolve(),
		/** Resolves once call `id` has finished. */
		finishedCall: (id: number) => once(done, id).promise,
	};
	addTool(
		setup.registry,
		tool("slow", async (args) => {
			await slows.gate(args.id ?? 0).promise;
			finished.push(args.id ?? 0);
			once(done, args.id ?? 0).resolve();
			return { output: [{ type: "text", text: `slow ${args.id}` }] };
		}),
	);
	return { setup, sandbox, vm, echo, holds, pauses, slows };
}

async function scriptTask(harness: Harness): Promise<TaskId> {
	const tasks = (await harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context)).items;
	return tasks.find((task) => (task.input as ToolTaskInput).kind === "model")!.id;
}

async function nestedCount(harness: Harness): Promise<number> {
	const tasks = (await harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context)).items;
	return tasks.filter((task) => (task.input as ToolTaskInput).kind === "nested").length;
}

/** The code mode call's result text. */
async function resultText(setup: ChatSetup, root: Awaited<ReturnType<typeof openChat>>["root"]) {
	void setup;
	const entry = (await allEntries(root)).find((candidate) => ToolResultEntry.is(candidate))!;
	const message = entry.model![0]!;
	return {
		// Without the "Script completed" header and its wall time, which tests of it check themselves.
		text:
			message.role === "toolResult"
				? message.content
						.map((item) => (item.type === "text" ? item.text : ""))
						.join("")
						.replace(/^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n/, "")
				: "",
		isError: message.role === "toolResult" && message.isError,
	};
}

/**
 * Run `code` until `holds.reached`, close the Harness (a restart), let `between` change the stored state, then reopen
 * with `hold` no longer blocking and wait for the answer.
 */
async function restart(
	chat: ReturnType<typeof codemodeChat>,
	code: string,
	between: (harness: Harness, task: TaskId) => Promise<void> = async () => {},
	beforeClose: (harness: Harness, task: TaskId) => Promise<void> = async () => {},
) {
	const path = await sqlitePath();
	chat.setup.faux.setResponses([script(code), DONE]);
	let opened = await openChat(await openNodeSqliteStorage(path), chat.setup);
	const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
	await chat.holds.reached.promise;
	await beforeClose(opened.harness, await scriptTask(opened.harness));
	await opened.harness.close(context);
	chat.holds.block = false;
	opened = await openChat(await openNodeSqliteStorage(path), chat.setup);
	await between(opened.harness, await scriptTask(opened.harness));
	opened.harness.resume();
	expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
	return { ...opened, result: await resultText(chat.setup, opened.root) };
}

describe("durable code mode", () => {
	it("runs a script that calls tools as nested calls", async () => {
		const chat = codemodeChat();
		chat.holds.block = false;
		chat.setup.faux.setResponses([
			script(`const a = await tools.echo({ text: "a" }); const b = await tools.echo({ text: "b" }); return [a, b];`),
			DONE,
		]);
		const { harness, root } = await openChat(await openNodeSqliteStorage(await sqlitePath()), chat.setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(await resultText(chat.setup, root)).toEqual({ text: '["echo a","echo b"]', isError: false });
		expect(await nestedCount(harness)).toBe(2);
		await harness.close(context);
	});

	it("resumes a script after a restart without running its finished calls again", async () => {
		const chat = codemodeChat();
		const { harness, result } = await restart(
			chat,
			`const a = await tools.echo({ text: "a" });
			const held = await tools.hold({ id: 1 });
			const b = await tools.echo({ text: "b" });
			return [a, held, b, Date.now() > 0];`,
		);
		expect(result).toEqual({ text: '["echo a","held 1","echo b",true]', isError: false });
		expect(Object.fromEntries(chat.echo)).toEqual({ a: 1, b: 1 });
		// The details list every call once, the one finished before the restart too (its row was saved with the dump).
		const entry = (await allEntries(await harness.root(context))).find((candidate) => ToolResultEntry.is(candidate))!;
		const details = (entry.model![0] as { details?: CodemodeToolDetails }).details;
		expect(details?.calls.map((call) => [call.id, call.name, call.status])).toEqual([
			[1, "echo", "ok"],
			[2, "hold", "ok"],
			[3, "echo", "ok"],
		]);
		// The VM ran twice, the second time from its dump; hold, replay-safe, reran once after the restart.
		expect(chat.vm.starts).toBe(2);
		expect(chat.holds.runs).toBe(2);
		await harness.close(context);
	});

	it("keeps the script's clock and randomness across a restart", async () => {
		const chat = codemodeChat();
		const { harness, result } = await restart(
			chat,
			`const before = [Date.now(), Math.random()];
			await tools.hold({});
			await tools.echo({ text: String(before[0]) + "/" + String(before[1]) });
			return "ok";`,
		);
		expect(result.text).toBe("ok");
		// One echo: the same arguments, so the rerun admitted no second call.
		expect([...chat.echo.values()]).toEqual([1]);
		await harness.close(context);
	});

	it("lists the script's tool calls in its result's details", async () => {
		const chat = codemodeChat();
		addTool(
			chat.setup.registry,
			tool("fails", async () => ({ output: [{ type: "text", text: "permission denied" }], isError: true })),
		);
		chat.setup.faux.setResponses([
			script(
				`await tools.echo({ text: "a" }); try { await tools.fails({}); } catch {} tools.hold({ id: 9 }); return 1;`,
			),
			DONE,
		]);
		const { harness, root } = await openChat(await openNodeSqliteStorage(await sqlitePath()), chat.setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const entry = (await allEntries(root)).find((candidate) => ToolResultEntry.is(candidate))!;
		const details = (entry.model![0] as { details?: CodemodeToolDetails }).details;
		// A call still running, or not yet launched, when the script ended shows as cancelled.
		expect(details?.calls).toMatchObject([
			{ id: 1, name: "echo", args: '{"text":"a"}', status: "ok" },
			{ id: 2, name: "fails", args: "{}", status: "error", error: "permission denied" },
			{ id: 3, name: "hold", args: '{"id":9}', status: "cancelled" },
		]);
		expect(details?.calls[0]?.durationMs).toBeGreaterThanOrEqual(0);
		await harness.close(context);
	});

	it("aborts a call still running when the script ends", async () => {
		const chat = codemodeChat();
		chat.setup.faux.setResponses([script(`tools.hold({}); await tools.echo({ text: "a" }); return 1;`), DONE]);
		const { harness, root } = await openChat(await openNodeSqliteStorage(await sqlitePath()), chat.setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(await resultText(chat.setup, root)).toEqual({ text: "1", isError: false });
		const tasks = (await harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context))
			.items;
		const hold = tasks.find(
			(task) =>
				(task.input as ToolTaskInput).kind === "nested" &&
				(task.input as { call: { name: string } }).call.name === "hold",
		)!;
		expect(chat.holds.runs).toBe(1);
		expect(hold.state).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
		await harness.close(context);
	});

	it("keeps a global's undefined result undefined, before and after a restart", async () => {
		const chat = codemodeChat([{ name: "nothing", execute: async () => undefined }]);
		const { harness, result } = await restart(
			chat,
			`const before = await nothing(); await tools.hold({}); return [before === undefined, (await nothing()) === undefined];`,
		);
		expect(result).toEqual({ text: "[true,true]", isError: false });
		await harness.close(context);
	});

	it("drops a global's result that arrives after the script finished", async () => {
		const late = deferred<string>();
		const chat = codemodeChat([
			{ name: "slowly", execute: () => late.promise },
			{ name: "quickly", execute: async () => "quick" },
		]);
		chat.setup.faux.setResponses([script(`const pending = slowly(); await quickly(); return 1;`), DONE]);
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		try {
			const { harness, root } = await openChat(await openNodeSqliteStorage(await sqlitePath()), chat.setup);
			await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
			expect(await resultText(chat.setup, root)).toEqual({ text: "1", isError: false });
			// The script's tool call has ended; its pending global resolves now.
			late.resolve("late");
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(rejections).toEqual([]);
			await harness.close(context);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});

	it("rejects a failed tool call with its error text and structured output", async () => {
		const chat = codemodeChat();
		addTool(
			chat.setup.registry,
			tool("fails", async () => ({ output: [{ type: "text", text: "permission denied" }], isError: true })),
		);
		chat.holds.block = false;
		chat.setup.faux.setResponses([
			script(`try { await tools.fails({}); } catch (e) { return [e.message, e.structuredOutput]; }`),
			DONE,
		]);
		const { harness, root } = await openChat(await openNodeSqliteStorage(await sqlitePath()), chat.setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(await resultText(chat.setup, root)).toEqual({
			text: '["permission denied","permission denied"]',
			isError: false,
		});
		await harness.close(context);
	});

	it("resolves a schema tool's error result that carries its value, and rejects one without with its text", async () => {
		const chat = codemodeChat();
		const Exit = obj({ output: str(), exitCode: num() });
		addTool(
			chat.setup.registry,
			defineTool({
				name: "run",
				description: "run",
				parameters: obj({}),
				structuredOutputSchema: Exit,
				// Like bash on a nonzero exit: an error result with its value.
				execute: async () => ({
					output: [{ type: "text", text: "no matches" }],
					structuredOutput: { output: "no matches", exitCode: 1 },
					isError: true,
				}),
			}),
		);
		addTool(
			chat.setup.registry,
			defineTool({
				name: "denied",
				description: "denied",
				parameters: obj({}),
				structuredOutputSchema: Exit,
				execute: async () => ({ output: [{ type: "text", text: "permission denied" }], isError: true }),
			}),
		);
		chat.holds.block = false;
		chat.setup.faux.setResponses([
			script(
				`const r = await tools.run({});
				let e; try { await tools.denied({}); } catch (error) { e = [error.message, error.structuredOutput ?? null]; }
				return [r.exitCode, r.output, e];`,
			),
			DONE,
		]);
		const { harness, root } = await openChat(await openNodeSqliteStorage(await sqlitePath()), chat.setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(await resultText(chat.setup, root)).toEqual({
			text: '[1,"no matches",["permission denied",null]]',
			isError: false,
		});
		await harness.close(context);
	});

	it("resolves a schema-less tool with its text, as its declaration says, also when it returned images", async () => {
		const chat = codemodeChat();
		const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
		addTool(
			chat.setup.registry,
			defineTool({
				name: "picture",
				description: "picture",
				parameters: obj({ caption: bool() }),
				execute: async (args) => ({
					output: [
						...(args.caption ? [{ type: "text" as const, text: "a cat" }] : []),
						{ type: "image" as const, data: PNG, mimeType: "image/png" },
					],
				}),
			}),
		);
		chat.holds.block = false;
		chat.setup.faux.setResponses([
			script(`return [await tools.picture({ caption: true }), await tools.picture({ caption: false })];`),
			DONE,
		]);
		const { harness, root } = await openChat(await openNodeSqliteStorage(await sqlitePath()), chat.setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(await resultText(chat.setup, root)).toEqual({ text: '["a cat",""]', isError: false });
		await harness.close(context);
	});

	it("ends a call started under another code mode version (the journal format) with an error asking to run it again", async () => {
		const chat = codemodeChat();
		const { harness, result } = await restart(
			chat,
			`await tools.hold({}); await tools.echo({ text: "late" });`,
			// What a store written by the journal format (version 2) holds for a running call: its start with a seed and
			// the VM's fingerprint, a journal of delivered results, and no saved run.
			async (opened, task) => {
				await opened.commit(async (tx) => {
					const run = await tx.doc(CodemodeRunDoc, task);
					Object.assign(run.start!, { version: 2, seed: 7, fingerprint: "quickjs-wasi 3.6.2" });
					const saved = await tx.doc(CodemodeSavedDoc, task);
					delete saved.saved;
					const journal = await tx.doc(JournalDoc, task);
					journal.entries.push({ id: 1, at: 0, issuedAfter: 1 });
				}, context);
			},
		);
		expect(result).toEqual({
			text: "Code mode was upgraded while this script ran, and the script cannot continue on the new version. Run it again.",
			isError: true,
		});
		expect(chat.echo.size).toBe(0);
		await harness.close(context);
	});

	it("counts the CPU budget across a restart, so a script that computes on after it resumes still ends", async () => {
		// Each loop uses about 60% of the budget: the first fits, both do not.
		const chat = codemodeChat([], undefined, 100_000_000);
		const { harness, result } = await restart(
			chat,
			`for (let i = 0; i < 12_000_000; i++);
			await tools.hold({});
			for (let i = 0; i < 12_000_000; i++);
			return "done";`,
		);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("Script timed out: The script used its CPU budget (about 0.2 s of computation)");
		// The VM ran twice: it resumed from its dump with the fuel it had used.
		expect(chat.vm.starts).toBe(2);
		await harness.close(context);
	});

	it("times a script out across a restart, without admitting new calls", async () => {
		const chat = codemodeChat();
		const { harness, result } = await restart(
			chat,
			`// @options: {"timeout_ms": 300}
			await tools.hold({}); await tools.echo({ text: "late" });`,
			() => new Promise((resolve) => setTimeout(resolve, 400)),
		);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("deadline passed");
		expect(chat.echo.size).toBe(0);
		expect(chat.vm.starts).toBe(1);
		await harness.close(context);
	});

	it("returns a decided outcome after a restart without running the script again", async () => {
		const chat = codemodeChat();
		const path = await sqlitePath();
		chat.holds.block = false;
		chat.setup.faux.setResponses([script(`return "first"`), DONE]);
		// Stop after execute() returned, so after the outcome is stored, and before the result commits.
		const stopped = { block: true, reached: deferred() };
		addHooks(chat.setup.registry, ToolTask, {
			afterTool: async (call, _result, _api, hookContext) => {
				if (call.name !== "codemode" || !stopped.block) return undefined;
				stopped.reached.resolve();
				await aborted(hookContext.abortSignal!);
				return undefined;
			},
		});
		let opened = await openChat(await openNodeSqliteStorage(path), chat.setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await stopped.reached.promise;
		const task = await scriptTask(opened.harness);
		expect((await opened.harness.snapshot(CodemodeRunDoc, task, context))?.result).toBeDefined();
		await opened.harness.close(context);
		stopped.block = false;
		opened = await openChat(await openNodeSqliteStorage(path), chat.setup);
		opened.harness.resume();
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		expect(await resultText(chat.setup, opened.root)).toEqual({ text: "first", isError: false });
		expect(chat.vm.starts).toBe(1);
		await opened.harness.close(context);
	});

	it("keeps store() values per conversation, as of a fork's entry", async () => {
		const chat = codemodeChat();
		chat.holds.block = false;
		chat.setup.faux.setResponses([
			script(`store("k", 1); return load("k")`),
			DONE,
			script(`return [load("k") ?? null]`),
			DONE,
		]);
		const { harness, root } = await openChat(await openNodeSqliteStorage(await sqlitePath()), chat.setup);
		await (await root.submit({ type: "input", content: "first" }, context)).wait(context);
		const firstUser = (await allEntries(root)).find((entry) => entry.kind === "pi.user")!;
		await (await root.submit({ type: "input", content: "second" }, context)).wait(context);
		const results = (await allEntries(root)).filter((entry) => ToolResultEntry.is(entry));
		const texts = results.map((entry) => (entry.model![0] as { content: { text: string }[] }).content[1]!.text);
		expect(texts).toEqual(["1", "[1]"]);
		// A fork at the first input is from before the first script stored anything.
		chat.setup.faux.setResponses([script(`return [load("k") ?? null]`), DONE]);
		const fork = await root.fork(firstUser.id, { ownership: { kind: "ownerless" } }, context);
		await (await fork.submit({ type: "input", content: "fork" }, context)).wait(context);
		const forkResult = (await allEntries(fork)).filter((entry) => ToolResultEntry.is(entry)).at(-1)!;
		expect((forkResult.model![0] as { content: { text: string }[] }).content[1]!.text).toBe("[null]");
		await harness.close(context);
	});

	it("saves the script once for the calls it makes together", async () => {
		const chat = codemodeChat();
		chat.holds.block = false;
		chat.setup.faux.setResponses([
			script(
				`return (await Promise.all(Array.from({ length: 50 }, (_, i) => tools.echo({ text: String(i) })))).length`,
			),
			DONE,
		]);
		const { harness, root } = await openChat(await openNodeSqliteStorage(await sqlitePath()), chat.setup);
		let saves = 0;
		harness.observeCommits({
			advance: (publication) => {
				for (const change of publication.changes) {
					if (change.type === "document" && change.record.kind === "pi.codemode.saved") saves++;
				}
			},
			end: () => {},
		});
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(await resultText(chat.setup, root)).toEqual({ text: "50", isError: false });
		// One save, and the document's retirement with its task: not one save per call (50).
		expect(saves).toBeLessThan(5);
		await harness.close(context);
	});
});

describe("durable code mode output and tool search", () => {
	/** Run `code` once in a chat with a Node environment; the result's content and details. */
	async function runScript(code: string, chat = codemodeChat()) {
		chat.holds.block = false;
		const cwd = await mkdtemp(join(tmpdir(), "pi-codemode-env-"));
		directories.add(cwd);
		chat.setup.faux.setResponses([script(code), DONE]);
		const { harness, root } = await openChat(await openNodeSqliteStorage(await sqlitePath()), chat.setup, {
			env: new NodeExecutionEnv({ cwd }),
		});
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const entry = (await allEntries(root)).find((candidate) => ToolResultEntry.is(candidate))!;
		const message = entry.model![0] as {
			content: { type: string; text?: string }[];
			isError: boolean;
			details?: CodemodeToolDetails;
		};
		await harness.close(context);
		return { text: message.content.map((item) => item.text ?? `<${item.type}>`).join(""), message };
	}

	it("lays out text items, console lines, and the returned value under a header", async () => {
		const { text } = await runScript(`text("one"); console.log("log", 1); text({ two: 2 }); return "three";`);
		expect(text).toMatch(/^Script completed\nWall time [\d.]+ seconds\nOutput:\n/);
		expect(text).toContain('==> text 1/3 <==\none\n==> text 2/3 <==\n{"two":2}\n==> text 3/3 <==\nthree');
		expect(text).toContain("<console_output>\nlog 1\n</console_output>");
	});

	it("cuts text past the token budget to its start and end, with the full text in a file", async () => {
		const { text, message } = await runScript(
			`// @options: {"max_output_tokens": 20}
			text("BEGIN" + "x".repeat(1000) + "END");`,
		);
		expect(text).toContain("Warning: truncated output");
		expect(text).toContain("BEGIN");
		expect(text).toContain("END");
		const path = message.details?.fullOutputPath;
		expect(text).toContain(`[Full output: ${path}`);
		expect(await readFile(path!, "utf8")).toBe(`BEGIN${"x".repeat(1000)}END`);
	});

	it("keeps a result inside the tool's output limits whatever max_output_tokens says, spilling the rest", async () => {
		// 6 MiB of text: over the Harness's 4 MiB limit, which would cut it without a spill file.
		const big = await runScript(
			`// @options: {"max_output_tokens": 2000000}
			return "x".repeat(6 * 1024 * 1024);`,
		);
		expect(big.text).toContain("Warning: truncated output");
		expect(big.text.length).toBeLessThanOrEqual(1024 * 1024 + 1000);
		expect((await readFile(big.message.details!.fullOutputPath!, "utf8")).length).toBe(6 * 1024 * 1024);
		// 200,000 short lines: within the byte limit, over the 100,000 lines one.
		const long = await runScript(
			`// @options: {"max_output_tokens": 2000000}
			return Array.from({ length: 200000 }, () => "a").join("\\n");`,
		);
		expect(long.text).toContain("Warning: truncated output");
		expect(long.text.split("\n").length).toBeLessThan(100_000);
		expect(long.message.details?.fullOutputPath).toBeDefined();
	});

	it("writes the result's files to the same paths when it reruns after a crash", async () => {
		const chat = codemodeChat();
		chat.holds.block = false;
		const cwd = await mkdtemp(join(tmpdir(), "pi-codemode-env-"));
		directories.add(cwd);
		const written = deferred<string>();
		// The process dies after the full output was written and before the result was committed.
		class CrashAfterWrite extends NodeExecutionEnv {
			override async writeFile(path: string, content: string | Uint8Array, callContext: Context) {
				const result = await super.writeFile(path, content, callContext);
				written.resolve(path);
				await aborted(callContext.abortSignal!);
				return result;
			}
		}
		const storage = await sqlitePath();
		chat.setup.faux.setResponses([script(`// @options: {"max_output_tokens": 20}\nreturn "x".repeat(1000);`), DONE]);
		let opened = await openChat(await openNodeSqliteStorage(storage), chat.setup, {
			env: new CrashAfterWrite({ cwd }),
		});
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		const first = await written.promise;
		await opened.harness.close(context);
		opened = await openChat(await openNodeSqliteStorage(storage), chat.setup, { env: new NodeExecutionEnv({ cwd }) });
		opened.harness.resume();
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		const entry = (await allEntries(opened.root)).find((candidate) => ToolResultEntry.is(candidate))!;
		const details = (entry.model![0] as { details?: CodemodeToolDetails }).details;
		expect(details?.fullOutputPath).toBe(first);
		directories.add(dirname(first));
		expect(await readdir(dirname(first))).toEqual(["output.txt"]);
		await opened.harness.close(context);
	});

	it("saves images to files and names them next to the image", async () => {
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
		const { text, message } = await runScript(`image("data:image/png;base64,${png}");`);
		const saved = /\[Image saved to (\S+) \(image\/png, \d+ bytes\)\]/.exec(text);
		expect(saved).not.toBeNull();
		expect((await readFile(saved![1]!)).toString("base64")).toBe(png);
		expect(message.content.some((item) => item.type === "image")).toBe(true);
	});

	// #11015
	it("resolves the built-in read with an image's block, which image() shows, and with a text file's text", async () => {
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
		const files = await mkdtemp(join(tmpdir(), "pi-codemode-read-"));
		directories.add(files);
		await writeFile(join(files, "pixel.png"), Buffer.from(png, "base64"));
		await writeFile(join(files, "note.txt"), "hello");
		const chat = codemodeChat();
		addTool(chat.setup.registry, createReadTool());
		const { text, message } = await runScript(
			`const picture = await tools.read({ path: ${JSON.stringify(join(files, "pixel.png"))} });
			text([picture.type, picture.mimeType, picture.data.length].join(" "));
			image(picture);
			text(await tools.read({ path: ${JSON.stringify(join(files, "note.txt"))} }));`,
			chat,
		);
		expect(message.isError).toBe(false);
		expect(text).toContain(`image image/png ${png.length}`);
		expect(text).toMatch(/\[Image saved to \S+ \(image\/png, \d+ bytes\)\]/);
		expect(text).toContain("hello");
		expect(message.content.some((item) => item.type === "image")).toBe(true);
	});

	it("calls a deferred tool the model is not offered, and finds it in ALL_TOOLS", async () => {
		const chat = codemodeChat();
		addTool(
			chat.setup.registry,
			defineTool({
				name: "later",
				description: "A deferred tool",
				parameters: obj({}),
				deferred: true,
				execute: async () => ({ output: [{ type: "text", text: "later ran" }] }),
			}),
		);
		const { text } = await runScript(
			`return [await tools.later({}), ALL_TOOLS.some((tool) => tool.name === "later")];`,
			chat,
		);
		expect(text).toContain('["later ran",true]');
	});

	it("reports a failed script with its error and the calls already made", async () => {
		const { text, message } = await runScript(`await tools.echo({ text: "a" }); throw new Error("boom");`);
		expect(message.isError).toBe(true);
		expect(text).toMatch(/^Script failed\n/);
		expect(text).toContain("Error: boom");
		expect(text).toContain("Tool calls made before the failure (they are not undone): echo (ok)");
	});

	it("finds tools with searchTools(), describeTool(), and describeNamespace(), and lists them in ALL_TOOLS", async () => {
		const chat = codemodeChat();
		// The namespace is the extension's: its tools belong to it whatever their names.
		chat.setup.registry.install(
			defineExtension({
				name: "mcp:github",
				namespace: {
					name: "github",
					description: "GitHub MCP server",
					instructions: "Pass the repository as owner/name.",
				},
				tools: [tool("list_issues", async () => ({ output: [] }))],
			}),
		);
		// A namespace without tools yet (a server waiting for sign-in) is described too.
		chat.setup.registry.install(
			defineExtension({ name: "mcp:linear", namespace: { name: "linear", description: "Linear: sign in first." } }),
		);
		const { text } = await runScript(
			`const found = await searchTools("issues");
			const byInstructions = await searchTools("repository owner");
			const inNamespace = await searchTools("echo", { namespace: "github" });
			return {
				found: found.map((tool) => tool.name),
				byInstructions: byInstructions.map((tool) => tool.name),
				inNamespace,
				described: (await describeTool("echo")).includes("echo(args:"),
				missing: (await describeTool("nope")) ?? null,
				namespace: await describeNamespace("github"),
				empty: await describeNamespace("linear"),
				all: ALL_TOOLS.map((tool) => tool.name).includes("list_issues"),
			};`,
			chat,
		);
		expect(JSON.parse(text.replace(/^Script completed\nWall time [\d.]+ seconds\nOutput:\n/, ""))).toEqual({
			found: ["list_issues"],
			byInstructions: ["list_issues"],
			inNamespace: [],
			described: true,
			missing: null,
			namespace: {
				name: "github",
				description: "GitHub MCP server",
				instructions: "Pass the repository as owner/name.",
				tools: ["list_issues"],
			},
			empty: { name: "linear", description: "Linear: sign in first.", tools: [] },
			all: true,
		});
	});
});

const Answer = defineSignal({ name: "test.answer", version: 1, schema: obj({ text: str() }) });
/** A chat whose code mode parks after 20 ms, with `echo` (recording its texts) and `ask` (parks on `Answer`). */
function setupWith(sandbox: CodemodeSandbox, echoes: string[]): ChatSetup {
	const setup = chatSetup();
	addTool(setup.registry, createCodemodeTool({ sandbox, parkAfterMs: 20 }));
	addTool(
		setup.registry,
		defineTool({
			name: "echo",
			description: "echo",
			parameters: obj({ text: opt(str()) }),
			replay: "safe",
			execute: async (args) => {
				echoes.push(args.text ?? "");
				return { output: [{ type: "text", text: `echo ${args.text ?? ""}` }] };
			},
		}),
	);
	addTool(
		setup.registry,
		defineTool({
			name: "ask",
			description: "ask a person",
			parameters: obj({}),
			replay: "safe",
			execute: async (_args, api, ctx) => {
				const state = await api.readSignal(Answer, "a", ctx);
				if (state?.kind === "value") return { output: [{ type: "text", text: state.value.text }] };
				return { kind: "sleep", signals: [Answer.key("a")] };
			},
		}),
	);
	return setup;
}

/** A new sandbox on the module loaded once, as another process would make. */
const newSandbox = () => new CodemodeSandbox({ wasm });

async function nested(harness: Harness, name: string) {
	const tasks = (await harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context)).items;
	return tasks.find((task) => (task.input as { call?: { name: string } }).call?.name === name);
}

async function parkedResult(root: Awaited<ReturnType<typeof openChat>>["root"]) {
	await waitFor(async () => (await allEntries(root)).some((entry) => ToolResultEntry.is(entry)), 10_000);
	const entry = (await allEntries(root)).find((candidate) => ToolResultEntry.is(candidate))!;
	const message = entry.model![0] as { content: { type: string; text?: string }[]; isError: boolean };
	return { isError: message.isError, text: message.content.map((item) => item.text ?? "").join("\n") };
}

describe("durable code mode saves and parks", () => {
	it("parks with its dump while a nested call is parked, and resumes it after a reopen", async () => {
		const path = await sqlitePath();
		const echoes: string[] = [];
		const code = `const a = await tools.echo({ text: "one" });
const answer = await tools.ask({});
return [a, answer, await tools.echo({ text: "two" })];`;
		let setup = setupWith(newSandbox(), echoes);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "s1" })], { stopReason: "toolUse" }),
		]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		await opened.root.submit({ type: "input", content: "go" }, context);
		await waitFor(async () => (await nested(opened.harness, "ask"))?.state.status === "sleeping");
		const script = (
			await opened.harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context)
		).items.find((task) => (task.input as { kind: string }).kind === "model")!;
		await waitFor(async () => (await opened.harness.getTask(script.id, context))?.state.status === "waiting");
		await waitFor(() => !opened.harness.wake().active);
		const saved = (await opened.harness.snapshot(CodemodeSavedDoc, script.id, context))?.saved as { dump: string };
		// Calls are open in the dump by id and identity; the script's body is in the dump, not referred to by hash.
		expect(saved.dump).toContain('$djs.resume(2, "tools.ask", [{}])');
		expect(saved.dump).not.toContain("$djs.source");
		await opened.harness.close(context);

		// Another process: a new sandbox, the same database.
		setup = setupWith(newSandbox(), echoes);
		setup.faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
		opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		const ask = await nested(opened.harness, "ask");
		expect(await opened.harness.signal(ask!.id, Answer, "a", { text: "yes" }, context)).toBe("delivered");
		expect(await parkedResult(opened.root)).toMatchObject({
			isError: false,
			text: expect.stringContaining('["echo one","yes","echo two"]'),
		});
		// Nothing ran twice.
		expect(echoes).toEqual(["one", "two"]);
		await opened.harness.close(context);
	});

	it("parks again on the calls still parked after one of them ends", async () => {
		const setup = setupWith(newSandbox(), []);
		const code = `const [a, b] = await Promise.all([tools.ask({}), tools.ask({})]); return a + "+" + b;`;
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "s1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(await openNodeSqliteStorage(await sqlitePath()), setup);
		harness.resume();
		await root.submit({ type: "input", content: "go" }, context);
		const asks = async () =>
			(await harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context)).items.filter(
				(task) => (task.input as { call?: { name: string } }).call?.name === "ask",
			);
		const script = async () =>
			(await harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context)).items.find(
				(task) => (task.input as { kind: string }).kind === "model",
			)!;
		await waitFor(async () => (await script())?.state.status === "waiting");
		const [first, second] = await asks();
		expect((await script()).state).toMatchObject({ on: [first!.id, second!.id], policy: "any" });
		await harness.signal(second!.id, Answer, "a", { text: "B" }, context);
		await waitFor(async () => {
			const state = (await script()).state as { status: string; on?: unknown[] };
			return state.status === "waiting" && state.on?.length === 1;
		});
		expect((await script()).state).toMatchObject({ status: "waiting", on: [first!.id] });
		await harness.signal(first!.id, Answer, "a", { text: "A" }, context);
		expect((await parkedResult(root)).text).toContain("A+B");
		await harness.close(context);
	});

	it("runs a script that holds what a dump cannot write in memory only, and never parks it", async () => {
		const setup = setupWith(newSandbox(), []);
		const code = `const seen = new WeakMap(); seen.set({}, 1); await tools.echo({ text: "x" }); return "kept " + typeof seen;`;
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "s1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(await openNodeSqliteStorage(await sqlitePath()), setup);
		harness.resume();
		await root.submit({ type: "input", content: "go" }, context);
		expect(await parkedResult(root)).toMatchObject({ isError: false, text: expect.stringContaining("kept object") });
		await harness.close(context);
	});
});
