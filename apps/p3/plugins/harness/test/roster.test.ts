// The session's subagents (`roster.ts`) on their own: the stopper's phases, called as the scheduler calls them over a
// stand-in of Durable's runtime (Astra, rounds 2 and 3 of the port). It aborts the subagent's current run only when a
// message of an older generation started it, never work of the stop's own generation; it clears the subagent's mark
// in the commit that ends it, only while the mark is its own; aborted itself, it clears the mark too. A message's
// request id carries its generation. Version 1's per-conversation documents are moved into the session's, once
// (decision 125): on its own, and on a worker whose store holds what main at 7093618af wrote (two top-level
// conversations listing one name each, a reported answer, a reporter of version 1 in flight).

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, contribute, defineFacet, until } from "@earendil-works/p3/v1";
import { testPlugin } from "@earendil-works/p3/v1/testing";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	createModels,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	type EntryId,
	fauxAssistantMessage,
	fauxProvider,
	Harness,
	SessionHarness,
	StoreStorage,
	WorkerRuntime,
} from "@earendil-works/p3/v1/worker";
import { eventually, within } from "../../../test/until.ts";
import { Anchor, adoptConversationRosters, MAX_NAME, requestOf, Stopper, Subagents } from "../roster.ts";
import { login, says, sessionRow, standIns, subagents } from "./stubs.ts";

/** The stopper's phase `name`, or its abort handler, as the scheduler calls them. */
function phase(name: "decide" | "abort" | "clear" | "aborted") {
	const definition = Stopper.definition as unknown as {
		phases: Record<string, (...args: unknown[]) => Promise<void>>;
		abort: (...args: unknown[]) => Promise<void>;
	};
	return name === "aborted" ? definition.abort : definition.phases[name]!;
}

/** A subagent conversation 2 in generation 1, its stop marked by stopper `stopping`. */
function agentOf(stopping: number) {
	return { conversationId: 2, generation: 1, reported: [], reportedTo: [], followUps: [], stopping };
}

/**
 * A runtime over the subagent `agent`, whose conversation runs `inputs` (submission ids, whose request ids `requests`
 * gives); records the next states and the conversations aborted.
 */
function runtimeOf(agent: object, inputs: number[] = [], requests: Record<number, string> = {}) {
	const states: { status: string; checkpoint?: { phase: string } }[] = [];
	const aborted: number[] = [];
	const tx = {
		doc: async (token: unknown) => (token === Subagents ? { agents: { reader: agent } } : { run: { inputs } }),
		submission: async (id: number) => ({ requestId: requests[id] }),
	};
	const runtime = {
		commit: async (fn: (tx: unknown) => unknown) => {
			states.push((await fn(tx)) as (typeof states)[number]);
		},
		conversation: async (id: number) => ({ abort: async () => void aborted.push(id) }),
	};
	return { runtime, states, aborted };
}

/** Stopper `id` of the subagent `reader`, conversation 2. */
function stopperOf(id: number) {
	return { id, input: { name: "reader", conversationId: 2 } };
}

describe("a subagent's stopper", () => {
	it("goes on to the abort when a message of an older generation started the current run", async () => {
		const { runtime, states } = runtimeOf(agentOf(5), [7], { 7: requestOf(30, 0) });
		await phase("decide")(stopperOf(5), runtime, context);
		assert.deepEqual(states, [{ status: "running", checkpoint: { phase: "abort" } }]);
	});

	it("aborts nothing of the stop's own generation: work sent after the stop's commit", async () => {
		const { runtime, states, aborted } = runtimeOf(agentOf(5), [8], { 8: requestOf(31, 1) });
		await phase("decide")(stopperOf(5), runtime, context);
		assert.deepEqual([states, aborted], [[{ status: "running", checkpoint: { phase: "clear" } }], []]);
	});

	it("decides by the subagent's current generation: a stop that reused it makes the first stop's work older (Astra, port 5)", async () => {
		const agent = { ...agentOf(5), generation: 2 };
		const { runtime, states } = runtimeOf(agent, [8], { 8: requestOf(31, 1) });
		await phase("decide")(stopperOf(5), runtime, context);
		assert.deepEqual(states, [{ status: "running", checkpoint: { phase: "abort" } }]);
	});

	it("reads a message of version 1 (`subagent:<reporter>`) as generation 0: a stop aborts it (Astra, port round 4)", async () => {
		const { runtime, states } = runtimeOf(agentOf(5), [7], { 7: "subagent:30" });
		await phase("decide")(stopperOf(5), runtime, context);
		assert.deepEqual(states, [{ status: "running", checkpoint: { phase: "abort" } }]);
	});

	it("aborts the subagent's conversation, then goes on to clear", async () => {
		const { runtime, states, aborted } = runtimeOf(agentOf(5));
		await phase("abort")(stopperOf(5), runtime, context);
		assert.deepEqual([aborted, states], [[2], [{ status: "running", checkpoint: { phase: "clear" } }]]);
	});

	it("clears its own mark as it ends, and leaves a later stop's", async () => {
		const own = agentOf(5);
		const { runtime, states } = runtimeOf(own);
		await phase("clear")(stopperOf(5), runtime, context);
		const later = agentOf(6);
		await phase("clear")(stopperOf(5), runtimeOf(later).runtime, context);
		assert.deepEqual([own.stopping, later.stopping, states[0]?.status], [undefined, 6, "terminal"]);
	});

	it("clears its mark when it is aborted itself, so the messages held back for it go on", async () => {
		const agent = agentOf(5);
		await phase("aborted")(stopperOf(5), runtimeOf(agent).runtime, context);
		assert.equal(agent.stopping, undefined);
	});
});

describe("the move of version 1's documents", () => {
	/**
	 * A stand-in harness whose conversations are `conversations` (owned by a task when `owner` is set), with version 1
	 * documents `v1` by conversation and the session's document `session` (none yet: `undefined`).
	 */
	function durableOf(
		conversations: { id: number; owner?: object }[],
		v1: Record<number, object>,
		session?: { agents: Record<string, object> },
	) {
		const written = { agents: {} as Record<string, unknown> };
		const durable = {
			snapshot: async (token: { definition: { scope: string } }, id?: number) =>
				token.definition.scope === "session" ? session : v1[id ?? -1] && { agents: v1[id ?? -1] },
			commit: async (change: (tx: unknown) => unknown) =>
				change({
					scanConversations: async () => ({ items: conversations }),
					doc: async () => written,
				}),
			conversation: async () => ({
				agent: async () => ({ model: { provider: "faux", modelId: "faux-model" }, thinkingLevel: "low" }),
			}),
		};
		return { durable: durable as never, written };
	}

	it("moves each conversation's subagents into the session's document, a name taken twice made unique", async () => {
		const { durable, written } = durableOf([{ id: 1 }, { id: 5, owner: { taskId: 2 } }, { id: 7 }], {
			1: { reader: { conversationId: 5, reported: [3] } },
			7: { reader: { conversationId: 9, reported: [] } },
		});
		await adoptConversationRosters(durable, context);
		const common = { model: "faux/faux-model", thinkingLevel: "low", generation: 0, followUps: [] };
		assert.deepEqual(written.agents, {
			reader: { conversationId: 5, reported: [3], reportedTo: [{ answer: 3, to: 1 }], ...common },
			"reader-9": { conversationId: 9, reported: [], reportedTo: [], ...common },
		});
	});

	it("moves nothing once the session's document exists", async () => {
		const { durable, written } = durableOf(
			[{ id: 1 }],
			{ 1: { reader: { conversationId: 5, reported: [] } } },
			{
				agents: {},
			},
		);
		await adoptConversationRosters(durable, context);
		assert.deepEqual(written.agents, {});
	});
});

/** Version 1 of the subagents' document, as main at 7093618af defined it: each conversation's subagents. */
const SubagentsV1 = defineDoc<{ agents: Record<string, { conversationId: ConversationId; reported: EntryId[] }> }>({
	checkpointWhen: () => false,
	kind: "harness.subagents",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {} }),
});

/** What the reporter of version 1 that ran before the update (`answered`, `saved`) saw: its message's answer settled. */
let answeredV1 = Promise.withResolvers<void>();

/** Whether the reporter of version 1 that runs before the update also decides its report (`saved`) before it. */
let savesV1 = false;

/**
 * Version 1 of the reporter, as main at 7093618af stored it: its name, version, input and phases. Its `deliver` does what
 * main's did up to the answer (submit, wait), and with `savesV1` also decides the report (main's `report` checkpoint,
 * the subagent named as then); then it waits for the update. A case that does not resume it never runs it.
 */
const ReporterV1 = defineTask<
	{ name: string; conversationId: ConversationId; message: string; followUp: boolean },
	{ phase: "deliver" } | { phase: "report"; report?: string },
	null
>({
	name: "harness.subagent-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (reporter, runtime, ctx) => {
			const child = await runtime.conversation(reporter.input.conversationId, ctx);
			const draft = { type: "input", content: reporter.input.message, whenBusy: "steer" } as const;
			const submission = await child?.submit({ ...draft, requestId: `subagent:${reporter.id}` }, ctx);
			const settled = await submission?.wait(ctx);
			if (savesV1 && settled?.status === "done" && settled.type === "input") {
				const report = `[subagent ${reporter.input.name} answered] old handled`;
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", report } }), ctx);
				answeredV1.resolve();
				return;
			}
			answeredV1.resolve();
			// The worker is updated before it reports: the phase runs again on the new code.
			await new Promise((resolve) => runtime.signal.addEventListener("abort", resolve));
		},
		// The worker is updated before the report is sent.
		report: async (_reporter, runtime) => {
			await new Promise((resolve) => runtime.signal.addEventListener("abort", resolve));
		},
	},
	abort: async () => {},
});

/**
 * What main at 7093618af left, by case: `plain`, a message in flight to the root's `reader`; `renamed`, one to the other
 * top-level conversation's `reader`, which the move renames; `answered`, that message answered before the update and
 * not yet reported; `saved`, that answer's report decided (naming the subagent as version 1 did) and not sent; `collision`, the root also lists a `reader-<the other's conversation>`; `long`, both subagents named
 * with 100 characters; `owned`, a subagent's conversation lists one of its own (Astra, round 4 of the port).
 */
type Variant = "plain" | "renamed" | "answered" | "saved" | "collision" | "long" | "owned";

/** What the case wrote: the subagents' conversations, the answer reported, the names used. */
type Written = {
	readonly first: ConversationId;
	readonly second: ConversationId;
	readonly answer: EntryId;
	readonly name: string;
	readonly third?: ConversationId;
};

/**
 * Writes into the worker's store what main at 7093618af left: the root conversation and another top-level one, each
 * listing a subagent `reader` in its version 1 document, the root's with one reported answer, and a reporter of version
 * 1 in flight (created, not run, but in case `answered`) with a message to one of them, as `variant` says. Durable is
 * opened on the store paused, closed before the harness opens.
 */
async function writeV1(store: WorkerRuntime["store"], variant: Variant, ctx: typeof context): Promise<Written> {
	const storage = await StoreStorage.open(store, "harness", ctx);
	const registry = createRegistry();
	registry.install(defineExtension({ name: "harness.subagent-tasks", tasks: [Anchor, ReporterV1] }));
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
	faux.setResponses([fauxAssistantMessage("old handled")]);
	models.setProvider(faux.provider);
	const durable = await Harness.open(storage, { models, registry }, ctx);
	const model = { provider: "faux", modelId: "faux-model" };
	try {
		const root = await durable.root(ctx);
		const written = await durable.commit(async (tx) => {
			const background = { ownership: { kind: "conversation" }, background: true } as const;
			// The agent's model, as the harness's first submit gave it.
			await configure(tx, root.id, { model });
			const branch = await tx.createConversation({ ownership: { kind: "ownerless" } });
			await configure(tx, branch.id, { model });
			const child = async (parent: ConversationId) => {
				const anchor = await tx.createTask(Anchor, null, { ...background, conversationId: parent });
				const created = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
				await configure(tx, created.id, { model });
				return created.id;
			};
			const name = variant === "long" ? "x".repeat(100) : "reader";
			const first = await child(root.id);
			const second = await child(branch.id);
			const answer = await tx.appendEntry(AssistantEntry, first, {
				model: [fauxAssistantMessage("an earlier answer")],
			});
			(await tx.doc(SubagentsV1, root.id)).agents[name] = { conversationId: first, reported: [answer.id] };
			(await tx.doc(SubagentsV1, branch.id)).agents[name] = { conversationId: second, reported: [] };
			let third: ConversationId | undefined;
			if (variant === "collision") {
				third = await child(root.id);
				(await tx.doc(SubagentsV1, root.id)).agents[`${name}-${second}`] = { conversationId: third, reported: [] };
			}
			if (variant === "owned") {
				third = await child(first);
				(await tx.doc(SubagentsV1, first)).agents.inside = { conversationId: third, reported: [] };
			}
			const toSecond = variant === "renamed" || variant === "answered" || variant === "saved";
			const input = { name, conversationId: toSecond ? second : first, message: "in flight", followUp: false };
			await tx.createTask(ReporterV1, input, { ...background, conversationId: toSecond ? branch.id : root.id });
			return { first, second, answer: answer.id, name, ...(third === undefined ? {} : { third }) };
		}, ctx);
		if (variant === "answered" || variant === "saved") {
			durable.resume();
			await answeredV1.promise;
			// The report decided: committed before the promise resolved.
		}
		return written;
	} finally {
		await durable.close(ctx);
	}
}

/**
 * The harness plugin opened on a worker whose store `writeV1` wrote for `variant` (written before the session's row is
 * served, so the harness opens on it only then), with a login answering `in flight` with "handled".
 */
async function migrated(variant: Variant) {
	answeredV1 = Promise.withResolvers<void>();
	savesV1 = variant === "saved";
	const folder = await realpath(await mkdtemp(join(tmpdir(), "p3-roster-")));
	const written = Promise.withResolvers<Written>();
	const v1 = defineFacet((host) => {
		contribute(host, "test.v1", (self) => {
			const runtime = self.registry(WorkerRuntime);
			self.open(
				async (ctx) => {
					written.resolve(await writeV1(runtime.value.store, variant, ctx));
					return null;
				},
				() => {},
			);
		});
	});
	const script = [says("in flight", "handled"), says("", "ok")];
	const facts = written.promise.then(() => {});
	const { stubs, server, control } = standIns(
		sessionRow("s1", folder),
		[login("l", "faux", script), subagents()],
		[],
		{
			facts,
		},
	);
	const t = await testPlugin(
		fileURLToPath(new URL("../", import.meta.url)),
		{ kind: "worker", session: "s1", stubs: [{ name: "test.v1", facet: v1 }, ...stubs], server },
		context,
	);
	const close = async () => {
		await t.close(context);
		await rm(folder, { recursive: true, force: true });
	};
	try {
		const open = await until(
			await t.host.registry(SessionHarness, context),
			(value) => value !== undefined,
			within("the harness", context, 10_000),
		);
		assert.ok(open !== undefined);
		const settled = async () => {
			await eventually(
				() => open.durable.inspect(context),
				({ tasks, submissions }) => tasks.length === 0 && submissions.length === 0,
				10_000,
			);
			return (await open.durable.snapshot(Subagents, context))?.agents ?? {};
		};
		return { written: await written.promise, control, settled, close };
	} catch (error) {
		await close();
		throw error;
	}
}

/** The reports the agent got, in order. */
function reportsOf(control: { requests: { last: string }[] }): string[] {
	return control.requests.filter(({ last }) => last.startsWith("[subagent ")).map(({ last }) => last);
}

describe("a worker whose store version 1 of the subagents wrote", () => {
	it("moves both subagents into the session's document and delivers the message in flight once (decision 125)", async () => {
		const { written, control, settled, close } = await migrated("plain");
		try {
			const { first, second, answer } = written;
			const roster = await settled();
			assert.deepEqual(Object.keys(roster), ["reader", `reader-${second}`]);
			const [reader, other] = [roster.reader, roster[`reader-${second}`]];
			// The earlier answer kept, the one to the message in flight added.
			assert.deepEqual([reader?.conversationId, reader?.reported[0], reader?.reported.length], [first, answer, 2]);
			assert.deepEqual(reader?.reportedTo[0], { answer, to: 1 });
			assert.deepEqual([other?.conversationId, other?.reported], [second, []]);
			// The message in flight reached the subagent once, and its answer came back once.
			assert.equal(control.requests.filter(({ last }) => last === "in flight").length, 1);
			assert.deepEqual(reportsOf(control), ["[subagent reader answered] handled"]);
		} finally {
			await close();
		}
	});

	it("delivers a message in flight to a subagent the move renamed, reported under its new name (Astra, port round 4)", async () => {
		const { written, control, settled, close } = await migrated("renamed");
		try {
			await settled();
			assert.equal(control.requests.filter(({ last }) => last === "in flight").length, 1);
			assert.deepEqual(reportsOf(control), [`[subagent reader-${written.second} answered] handled`]);
		} finally {
			await close();
		}
	});

	it("reports an answer given before the update to its sender once, without asking again (Astra, port round 4)", async () => {
		const { written, control, settled, close } = await migrated("answered");
		try {
			await settled();
			assert.equal(control.requests.filter(({ last }) => last === "in flight").length, 0);
			assert.deepEqual(reportsOf(control), [`[subagent reader-${written.second} answered] old handled`]);
		} finally {
			await close();
		}
	});

	it("sends a report decided before the update under the subagent's new name (Astra, port round 4)", async () => {
		const { written, control, settled, close } = await migrated("saved");
		try {
			await settled();
			assert.equal(control.requests.filter(({ last }) => last === "in flight").length, 0);
			assert.deepEqual(reportsOf(control), [`[subagent reader-${written.second} answered] old handled`]);
		} finally {
			await close();
		}
	});

	it("keeps every subagent when a renamed one's new name is taken already (Astra, port round 4)", async () => {
		const { written, settled, close } = await migrated("collision");
		try {
			const roster = await settled();
			const conversations = Object.values(roster).map(({ conversationId }) => conversationId);
			assert.deepEqual(conversations.toSorted(), [written.first, written.second, written.third].toSorted());
		} finally {
			await close();
		}
	});

	it("gives a renamed subagent a name the tool takes, also from a name of 100 characters (Astra, port round 4)", async () => {
		const { settled, close } = await migrated("long");
		try {
			const names = Object.keys(await settled());
			assert.equal(names.length, 2);
			assert.ok(
				names.every((name) => name.length <= MAX_NAME),
				names.join(", "),
			);
		} finally {
			await close();
		}
	});

	it("moves a subagent a subagent's conversation listed too (Astra, port round 4)", async () => {
		const { written, settled, close } = await migrated("owned");
		try {
			assert.equal((await settled()).inside?.conversationId, written.third);
		} finally {
			await close();
		}
	});
});
