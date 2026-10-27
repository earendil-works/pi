import { createModels, fauxAssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	type AnyTask,
	createRegistry,
	defineExtension,
	defineTask,
	defineTool,
	GenerationTask,
	Harness,
	hook,
	MemoryStorage,
	type ReportInfo,
	type SetTimer,
	section,
	wrapTool,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { chatSetup } from "./chat-support.ts";
import { ControlledStorage, context } from "./session-support.ts";
import { completed, deferred, eventually } from "./task-support.ts";

type Report = { readonly message: string; readonly info: ReportInfo };

/** Open a Harness with `tasks` installed that collects every report's message and info. */
async function open(
	tasks: readonly AnyTask[],
	options: { readonly storage?: MemoryStorage; readonly onWake?: () => void; readonly setTimer?: SetTimer } = {},
) {
	const registry = createRegistry();
	registry.install(defineExtension({ name: "test", tasks }));
	const reports: Report[] = [];
	const harness = await Harness.open(
		options.storage ?? new MemoryStorage(),
		{
			models: createModels(),
			registry,
			onReport: (error, info) => reports.push({ message: (error as Error).message, info }),
			...(options.onWake === undefined ? {} : { onWake: options.onWake }),
			...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
		},
		context,
	);
	return { harness, registry, reports };
}

describe("reports", () => {
	it("say which task reported a failure or faulted", async () => {
		const Faulty = defineTask<null, { phase: "run" }, null>({
			name: "test.faulty",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime) => {
					runtime.report(new Error("noted"));
					throw new Error("broken");
				},
			},
			abort: async () => {},
		});
		const { harness, reports } = await open([Faulty]);
		const root = await harness.root(context);
		const id = await root.commit(
			(tx) => tx.createTask(Faulty, null, { ownership: { kind: "conversation" } }),
			context,
		);
		harness.resume();
		expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("faulted");
		await eventually(() => reports.length === 2);
		// The task's own failures name the extension that installed it.
		const task = { task: { id, kind: "test.faulty", conversationId: root.id }, extension: "test" };
		expect(reports).toEqual([
			{ message: "noted", info: { type: "task_error", ...task } },
			{ message: "broken", info: { type: "task_faulted", ...task, reason: "threw" } },
		]);
		await harness.close(context);
	});

	it("name the extension whose definition ran, also after another one replaced it", async () => {
		const gate = deferred();
		const started = deferred();
		const definition = (name: string) =>
			defineTask<null, { phase: "run" }, null>({
				name: "test.replaced",
				version: 1,
				initial: () => ({ phase: "run" }),
				phases: {
					run: async () => {
						started.resolve();
						await gate.promise;
						throw new Error(`broken in ${name}`);
					},
				},
				abort: async () => {},
			});
		const Old = definition("old");
		const { harness, registry, reports } = await open([]);
		const old = defineExtension({ name: "old-extension", tasks: [Old] });
		registry.install(old);
		const root = await harness.root(context);
		const id = await root.commit((tx) => tx.createTask(Old, null, { ownership: { kind: "conversation" } }), context);
		harness.resume();
		await started.promise;
		registry.uninstall(old);
		registry.install(defineExtension({ name: "new-extension", tasks: [definition("new")] }));
		gate.resolve();
		await harness.waitForTask(id, context);
		const faulted = (report: Report) => report.info.type === "task_faulted";
		await eventually(() => reports.some(faulted));
		expect(reports.find(faulted)).toMatchObject({
			message: "broken in old",
			info: { extension: "old-extension" },
		});
		await harness.close(context);
	});

	it("name the extension of a failing section or hook, and tell them from a failing environment builder", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([fauxAssistantMessage("answer")]);
		setup.registry.install(
			defineExtension({
				name: "sections",
				sections: [
					section("broken", () => {
						throw new Error("section");
					}),
				],
			}),
		);
		setup.registry.install(
			defineExtension({
				name: "hooks",
				hooks: [
					hook(GenerationTask, {
						afterResponse: () => {
							throw new Error("hook");
						},
					}),
				],
			}),
		);
		const reports: Report[] = [];
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: setup.models,
				registry: setup.registry,
				env: () => {
					throw new Error("env");
				},
				onReport: (error, info) => reports.push({ message: (error as Error).message, info }),
			},
			context,
		);
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);
		const infoOf = (message: string) => reports.find((report) => report.message === message)?.info;
		const generation = { kind: "pi.generation", conversationId: root.id };
		expect(infoOf("env")).toMatchObject({ type: "host_error", callback: "env", task: generation });
		expect(infoOf("section")).toMatchObject({ type: "extension_error", extension: "sections", task: generation });
		expect(infoOf("hook")).toMatchObject({ type: "extension_error", extension: "hooks", task: generation });
		await harness.close(context);
	});

	it("tell extension, listener, wake, and timer failures from a failed Session", async () => {
		const Sleeper = defineTask<null, { phase: "run" } | { phase: "done" }, null>({
			name: "test.sleeper",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: (_task, runtime, ctx) => {
					// The host's setTimer throws: reported, and armed with setTimeout instead.
					runtime.setTimer(() => {}, 10);
					return runtime.sleepUntil(runtime.now() + 60_000, { phase: "done" }, ctx);
				},
				done: (_task, runtime, ctx) => runtime.commit(() => completed(null), ctx),
			},
			abort: async () => {},
		});
		const storage = new ControlledStorage();
		const { harness, registry, reports } = await open([Sleeper], {
			storage,
			onWake: () => {
				throw new Error("alarm");
			},
			setTimer: () => {
				throw new Error("no timers");
			},
		});
		const echo = defineTool({
			name: "echo",
			description: "echo",
			parameters: Type.Object({}),
			execute: async () => ({}),
		});
		registry.install(defineExtension({ name: "tools", tools: [echo] }));
		registry.install(
			defineExtension({ name: "wraps", wraps: [wrapTool(echo, (tool) => ({ ...tool, name: "renamed" }))] }),
		);
		harness.subscribeCommits(() => {
			throw new Error("listener");
		});
		const root = await harness.root(context);
		await root.agent(context);
		await root.commit((tx) => tx.createTask(Sleeper, null, { ownership: { kind: "conversation" } }), context);
		harness.resume();
		await eventually(() =>
			["alarm", "no timers"].every((message) => reports.some((report) => report.message === message)),
		);
		const infoOf = (message: string) => reports.find((report) => report.message === message)?.info;
		expect(infoOf("Wrapper renamed echo to renamed")).toEqual({
			type: "extension_error",
			conversationId: root.id,
			extension: "wraps",
		});
		expect(infoOf("listener")).toEqual({ type: "listener_error" });
		expect(infoOf("alarm")).toEqual({ type: "host_error", callback: "onWake" });
		expect(infoOf("no timers")).toEqual({ type: "host_error", callback: "setTimer" });

		const failure = new Error("disk gone");
		storage.failNextCommit(failure);
		await root.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context).catch(() => {});
		await harness.closed;
		expect(infoOf("disk gone")).toEqual({ type: "session_failed" });
	});
});
