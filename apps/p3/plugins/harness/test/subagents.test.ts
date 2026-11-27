// The subagents' part on a worker (`harnessed`: the harness plugin beside stand-ins and a scripted login): the one
// `subagent` tool for the main conversation while Use is granted, and never a subagent's; each action (spawn, send,
// configure, stop, archive, restore, answer, status, models) and its refusals; answers reported back once to each
// sender; follow-ups delivered after the current answer, in the order sent, each with its sender's tools; a subagent's
// tools taken from the agent again with each message (never `main` ones, never one the agent lacks); Use withheld
// giving a running subagent no new message and withdrawing the waiting ones; stop and archive bound to the generation
// they end, also against a send in one round; the session's subagents in every top-level branch.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, obj } from "@earendil-works/p3/v1";
import { configure, defineTool } from "@earendil-works/p3/v1/worker";
import { eventually } from "../../../test/until.ts";
import type { HarnessTool } from "../../things/contract.worker.ts";
import { SESSION } from "../../things/test/part.ts";
import { Subagents } from "../roster.ts";
import { subagentsPart } from "../subagents.ts";
import {
	calls,
	coding,
	type Extra,
	type Harnessed,
	type Holding,
	harnessed,
	login,
	other,
	runs,
	type Step,
	says,
	sessionRow,
	subagents,
} from "./stubs.ts";

/** A spawn of `reader` with `message`, and `more` fields. */
function spawn(when: string, message: string, more: object = {}): Step {
	return calls(when, "subagent", { action: "spawn", name: "reader", message, ...more });
}

/** The action `action` on `reader`, with `more` fields. */
function on(when: string, action: string, more: object = {}): Step {
	return calls(when, "subagent", { action, name: "reader", ...more });
}

/** A tool that answers `ran <name>`, a `main` one with `scope`. */
function testTool(name: string, scope?: "main"): HarnessTool {
	const tool = defineTool({
		name,
		description: `The test tool ${name}`,
		parameters: obj({}),
		execute: async () => ({ output: [{ type: "text", text: `ran ${name}` }] }),
	});
	return scope === undefined ? tool : { ...tool, scope };
}

describe("the subagents' part", () => {
	let folder: string;
	let loaded: Harnessed | undefined;

	beforeEach(async () => {
		folder = await realpath(await mkdtemp(join(tmpdir(), "p3-subagents-")));
	});

	afterEach(async () => {
		// A case that waits on a gate releases it, also when it failed.
		for (const gate of ["gate", "gate2", "parent-gate"]) await writeFile(join(folder, gate), "");
		await loaded?.t.close(context);
		loaded = undefined;
		await rm(folder, { recursive: true, force: true });
	});

	/** Loads the harness holding `held`, with the `extras` parts. */
	async function start(held: Holding[], extras: Extra[] = []): Promise<Harnessed> {
		loaded = await harnessed(sessionRow("s1", folder), held, context, extras);
		return loaded;
	}

	/** What the scripted logins received so far. */
	function requests() {
		assert.ok(loaded !== undefined);
		return loaded.control.requests;
	}

	/** The last text of the first request answering `when` (a tool's result the model got). */
	function seen(when: (last: string) => boolean): string {
		const found = requests().find(({ last }) => when(last));
		assert.ok(
			found !== undefined,
			`no request matched: ${requests()
				.map(({ last }) => last)
				.join(" | ")}`,
		);
		return found.last;
	}

	/** The JSON results of the status calls, in order. */
	function statuses(): unknown[] {
		return requests()
			.filter(({ last }) => last.startsWith('{"subagents"'))
			.map(({ last }) => JSON.parse(last));
	}

	/** Waits until the agent got the report `text` once, then until the session is idle. */
	async function reported(text: string): Promise<void> {
		await eventually(
			() => requests().filter(({ last }) => last === text).length,
			(count) => count === 1,
			5000,
		).catch((error: unknown) => {
			// What the model got instead says where the script went.
			throw new Error(
				`${String(error)}; the requests: ${requests()
					.map(({ last }) => last)
					.join(" | ")}`,
			);
		});
		assert.ok(loaded !== undefined);
		await (await loaded.harness()).durable.waitForIdle(context);
	}

	/** Waits until `count` follow-ups to `reader` wait for its current answer. */
	async function waiting(count: number): Promise<void> {
		assert.ok(loaded !== undefined);
		const { durable } = await loaded.harness();
		await eventually(
			async () => (await durable.snapshot(Subagents, context))?.agents.reader?.followUps.length,
			(length) => length === count,
		);
	}

	/** Waits until the bash call of a subagent's first step started. */
	async function started(): Promise<void> {
		await eventually(() => existsSync(join(folder, "started")), Boolean);
	}

	it("starts a subagent, a copy without the subagent tool, whose answer comes back; Use withheld: no tool", async () => {
		const script = [
			spawn("@spawn", "Summarize the plan"),
			says('"done":"started"', "started"),
			says("Summarize the plan", "the summary"),
			says("[subagent reader answered] the summary", "noted"),
			calls("@status", "subagent", { action: "status" }),
			says("", "ok"),
		];
		const held = [login("login", "faux", script), coding(), subagents()];
		const { ask, control } = await start(held);
		await ask("@spawn");
		await reported("[subagent reader answered] the summary");
		assert.deepEqual(requests()[0]?.tools, ["bash", "edit", "read", "subagent", "write"]);
		const child = requests().find(({ last }) => last === "Summarize the plan");
		assert.deepEqual(child?.tools, ["bash", "edit", "read", "write"], "the subagent has no subagent tool");
		await ask("@status");
		const all = "all";
		const reader = { name: "reader", working: false, model: "faux/faux-model", thinkingLevel: "off", tools: all };
		assert.deepEqual(statuses(), [{ subagents: [reader] }]);
		control.hold([held[0]!, held[1]!, subagents(false)]);
		await ask("after");
		assert.deepEqual(requests().at(-1)?.tools, ["bash", "edit", "read", "write"]);
	});

	it("delivers a follow-up sent while the run fails after it, instead of leaving it queued (Astra, rounds 1 and 2)", async () => {
		const script = [
			spawn("@spawn", "child-start"),
			runs("child-start", "touch started; until [ -e gate ]; do sleep 0.02; done; echo not-scripted"),
			says('"done":', "ok"),
			on("@queue", "send", { message: "later", followUp: true }),
			says("later", "taken after the failure"),
			says("[subagent reader failed:", "noted"),
			says("[subagent reader answered]", "noted"),
		];
		const { harness } = await start([login("l", "faux", script), coding(), subagents()]);
		const open = await harness();
		await open.submit(undefined, { text: "@spawn", requestId: "spawn" }, context);
		await started();
		await open.submit(undefined, { text: "@queue", requestId: "q" }, context);
		await waiting(1);
		await writeFile(join(folder, "gate"), "");
		await reported("[subagent reader answered] taken after the failure");
		assert.ok(
			requests().some(({ last }) => last.startsWith("[subagent reader failed:")),
			"the first run's failure",
		);
		await eventually(
			() => open.durable.inspect(context),
			(found) => found.tasks.length === 0 && found.submissions.length === 0,
			5000,
		);
	});

	it("reports each answer once; archived, it leaves status but for its name; send and restore bring it back", async () => {
		const script = [
			spawn("@spawn", "first task"),
			says("first task", "first answer"),
			says("[subagent reader answered] first answer", "noted one"),
			on("@send", "send", { message: "second task" }),
			says("second task", "second answer"),
			says("[subagent reader answered] second answer", "noted two"),
			on("@hide-1", "archive"),
			calls("@all", "subagent", { action: "status" }),
			on("@named", "status"),
			on("@restore", "restore"),
			on("@hide-2", "archive"),
			on("@third", "send", { message: "third task" }),
			says("third task", "third answer"),
			says("", "ok"),
		];
		const { ask } = await start([login("login", "faux", script), coding(), subagents()]);
		await ask("@spawn");
		await reported("[subagent reader answered] first answer");
		await ask("@send");
		await reported("[subagent reader answered] second answer");
		// Each request has its own text: the text is its request id.
		await ask("@hide-1");
		await ask("@all-1");
		await ask("@named");
		await ask("@restore");
		await ask("@all-2");
		await ask("@hide-2");
		await ask("@third");
		await reported("[subagent reader answered] third answer");
		await ask("@all-3");
		const reader = { name: "reader", working: false, model: "faux/faux-model", thinkingLevel: "off", tools: "all" };
		assert.deepEqual(statuses(), [
			{ subagents: [], archived: 1 },
			{ subagents: [{ ...reader, archived: true }] },
			{ subagents: [reader] },
			{ subagents: [reader] },
		]);
		assert.equal(requests().filter(({ last }) => last.startsWith("[subagent reader answered]")).length, 3);
	});

	it("reports an answer that ends two messages once: a steer taken into the running work", async () => {
		const script = [
			spawn("@spawn", "child-start"),
			runs("child-start", "touch started; until [ -e gate ]; do sleep 0.02; done; echo first done"),
			says("and this too", "both done"),
			on("@steer", "send", { message: "and this too" }),
			says("", "ok"),
		];
		const { ask, harness } = await start([login("login", "faux", script), coding(), subagents()]);
		await ask("@spawn");
		await started();
		await ask("@steer");
		await writeFile(join(folder, "gate"), "");
		await reported("[subagent reader answered] both done");
		await eventually(
			async () => (await (await harness()).durable.inspect(context)).tasks.length,
			(count) => count === 0,
			5000,
		);
		assert.equal(requests().filter(({ last }) => last.startsWith("[subagent reader answered]")).length, 1);
	});

	it("gives a running subagent no new message once Use is withheld (ERNDL-1171, test 2)", async () => {
		const script = [
			spawn("@spawn", "child-start"),
			runs("child-start", "touch started; until [ -e gate ]; do sleep 0.02; done; echo first done"),
			says('"done":', "ok"),
			on("@send", "send", { message: "a new message" }),
			says("", "ok"),
		];
		const held = [login("login", "faux", script), coding(), subagents()];
		const { ask, control, harness } = await start(held);
		const open = await harness();
		await open.submit(undefined, { text: "@spawn", requestId: "spawn" }, context);
		await started();
		control.hold([held[0]!, held[1]!, subagents(false)]);
		await ask("@send");
		const offered = requests().find(({ last }) => last === "@send")?.tools ?? [];
		assert.ok(!offered.includes("subagent"), offered.join());
		await writeFile(join(folder, "gate"), "");
		await open.durable.waitForIdle(context);
		// The running subagent finished its step; it never got the new message.
		assert.ok(!requests().some(({ last }) => last.includes("a new message")));
	});

	it("configures a subagent's model, thinking level and tools for its later work", async () => {
		const a = login("a", "faux-a", [
			spawn("@spawn", "one"),
			says("one", "first"),
			on("@configure", "configure", { model: "faux-b/faux-b-model", thinkingLevel: "high", tools: ["read"] }),
			on("@send", "send", { message: "two" }),
			says("", "ok"),
		]);
		const b = login("b", "faux-b", [says("two", "second"), says("", "b")]);
		const { ask } = await start([a, b, coding(), subagents()]);
		await ask("@spawn");
		await reported("[subagent reader answered] first");
		await ask("@configure");
		await ask("@send");
		await reported("[subagent reader answered] second");
		const configured = JSON.parse(seen((last) => last.startsWith('{"name":"reader","working"')));
		assert.deepEqual(configured, {
			name: "reader",
			working: false,
			model: "faux-b/faux-b-model",
			// Clamped: the faux model has no reasoning.
			thinkingLevel: "off",
			tools: ["read"],
		});
		const [first, second] = [
			requests().find(({ last }) => last === "one"),
			requests().find(({ last }) => last === "two"),
		];
		assert.deepEqual([first?.provider, first?.tools], ["faux-a", ["bash", "edit", "read", "write"]]);
		assert.deepEqual([second?.provider, second?.tools], ["faux-b", ["read"]]);
	});

	it("refuses what it cannot do, and writes nothing then", async () => {
		const script = [
			spawn("@own", "child-task", { tools: ["subagent"] }),
			spawn("@model", "child-task", { model: "faux/model" }),
			spawn("@spawn", "child-task"),
			says("child-task", "child answer"),
			spawn("@again", "another"),
			calls("@nobody", "subagent", { action: "send", name: "nobody", message: "hi" }),
			on("@empty", "configure"),
			on("@nameless", "send", { name: undefined, message: "hi" }),
			says("", "ok"),
		];
		const { ask } = await start([login("login", "faux", script), coding(), subagents()]);
		for (const text of ["@own", "@model", "@spawn"]) await ask(text);
		await reported("[subagent reader answered] child answer");
		for (const text of ["@again", "@nobody", "@empty", "@nameless"]) await ask(text);
		const refusals = requests()
			.map(({ last }) => last)
			.filter((last) => last.includes("subagent: "));
		const expected = [
			/you cannot give the tool subagent; you may give: read, write, edit, bash/,
			/no model faux\/model\. Close matches: faux\/faux-model\./,
			/reader exists already/,
			/you have no subagent named nobody/,
			/configure takes `model`, `thinkingLevel` or `tools`/,
			/send takes `name`/,
		];
		assert.equal(refusals.length, expected.length, refusals.join(" | "));
		for (const [at, pattern] of expected.entries()) assert.match(refusals[at] ?? "", pattern);
		// The refused spawns started nothing: the one spawn that went through is the only subagent.
		assert.equal(requests().filter(({ last }) => last === "child-task").length, 1);
	});

	it("stops a subagent's work; it stays and takes the next message", async () => {
		const script = [
			spawn("@spawn", "child-start"),
			runs("child-start", "touch started; until [ -e gate ]; do sleep 0.02; done; echo not stopped"),
			on("@stop", "stop"),
			on("@status", "status"),
			on("@send", "send", { message: "after the stop" }),
			says("after the stop", "back"),
			says("", "ok"),
		];
		const { ask } = await start([login("login", "faux", script), coding(), subagents()]);
		await ask("@spawn");
		await started();
		await ask("@stop");
		await ask("@status");
		await ask("@send");
		await reported("[subagent reader answered] back");
		assert.equal((statuses()[0] as { subagents: { working: boolean }[] }).subagents[0]?.working, false);
		// The stopped message was withdrawn by the stop: nothing reported for it, and its tool call never finished.
		assert.ok(
			!requests().some(({ last }) => last.startsWith("[subagent reader failed") || last.includes("not stopped")),
		);
	});

	it("answers a subagent's latest answer again, and whether it is working on a newer one (Opus, round 1)", async () => {
		const script = [
			spawn("@spawn", "child-start"),
			runs("child-start", "touch started; until [ -e gate ]; do sleep 0.02; done; echo ran"),
			says("ran", "the final answer"),
			on("@early", "answer"),
			on("@late", "answer"),
			on("@more", "send", { message: "more-work" }),
			runs("more-work", "touch more; until [ -e gate2 ]; do sleep 0.02; done; echo again"),
			says("again", "a newer answer"),
			on("@during", "answer"),
			says("", "ok"),
		];
		const { ask } = await start([login("login", "faux", script), coding(), subagents()]);
		await ask("@spawn");
		await started();
		await ask("@early");
		await writeFile(join(folder, "gate"), "");
		await reported("[subagent reader answered] the final answer");
		await ask("@late");
		await ask("@more");
		await eventually(() => existsSync(join(folder, "more")), Boolean);
		await ask("@during");
		await writeFile(join(folder, "gate2"), "");
		await reported("[subagent reader answered] a newer answer");
		const answers = requests()
			.filter(({ last }) => last.startsWith('{"name":"reader","working"'))
			.map(({ last }) => JSON.parse(last));
		assert.deepEqual(answers, [
			{ name: "reader", working: true, answer: null },
			{ name: "reader", working: false, answer: "the final answer" },
			{ name: "reader", working: true, answer: "the final answer" },
		]);
	});

	it("lists the models with credentials, all or those a query matches", async () => {
		const script = [
			calls("@all", "subagent", { action: "models" }),
			calls("@b", "subagent", { action: "models", model: "faux b" }),
			says("", "ok"),
		];
		const { ask } = await start([login("a", "faux-a", script), login("b", "faux-b", []), subagents()]);
		await ask("@all");
		await ask("@b");
		const listed = requests()
			.filter(({ last }) => last.startsWith('{"models"'))
			.map(({ last }) => (JSON.parse(last) as { models: { model: string }[] }).models.map(({ model }) => model));
		assert.deepEqual(listed, [["faux-a/faux-a-model", "faux-b/faux-b-model"], ["faux-b/faux-b-model"]]);
	});

	it("leaves main tools out of a subagent's, also one given after its spawn", async () => {
		const script = [
			spawn("@spawn", "child-hello"),
			says("child-hello", "hi"),
			on("@send", "send", { message: "use later" }),
			says("use later", "later done"),
			says("", "ok"),
		];
		const held = [login("login", "faux", script), coding(), subagents(), other("test.scoped", "s")];
		const extras: Extra[] = [
			{ kind: "test.scoped", tools: [testTool("test_main", "main")] },
			{ kind: "test.later", tools: [testTool("test_later", "main")] },
		];
		const { ask, control } = await start(held, extras);
		await ask("@spawn");
		await reported("[subagent reader answered] hi");
		assert.deepEqual(requests()[0]?.tools, ["bash", "edit", "read", "subagent", "test_main", "write"]);
		const child = requests().find(({ last }) => last === "child-hello");
		assert.deepEqual(child?.tools, ["bash", "edit", "read", "write"]);
		control.hold([...held, other("test.later", "l")]);
		await ask("@send");
		await reported("[subagent reader answered] later done");
		assert.deepEqual(requests().find(({ last }) => last === "use later")?.tools, ["bash", "edit", "read", "write"]);
	});

	it("gives a subagent the agent's tools again with each message: a new one, and none it let go of (Opus S1)", async () => {
		const script = [
			spawn("@spawn", "child-hello"),
			says("child-hello", "hi"),
			on("@send", "send", { message: "second message" }),
			says("second message", "second done"),
			says("", "ok"),
		];
		const held = [login("login", "faux", script), coding(), subagents()];
		const { ask, control } = await start(held, [{ kind: "test.later", tools: [testTool("test_plain")] }]);
		await ask("@spawn");
		await reported("[subagent reader answered] hi");
		// The coding tools let go of, a plain tool given.
		control.hold([held[0]!, held[2]!, other("test.later", "l")]);
		await ask("@send");
		await reported("[subagent reader answered] second done");
		assert.deepEqual(requests().find(({ last }) => last === "second message")?.tools, ["test_plain"]);
	});

	it("gives a default subagent only the tools its agent has, also when the agent's are a selection (Astra, must 1)", async () => {
		const script = [spawn("@spawn", "child"), says("child", "done"), says("", "ok")];
		const { ask, harness } = await start(
			[login("a", "faux", script), subagents(), other("test.labels", "labels")],
			[{ kind: "test.labels", tools: [testTool("red_label"), testTool("blue_label")] }],
		);
		const open = await harness();
		const parent = await open.durable.root(context);
		const keep = (await parent.agent(context)).tools.filter((t) => t.name === "subagent" || t.name === "red_label");
		await open.durable.commit((tx) => configure(tx, parent.id, { tools: keep }), context);
		await ask("@spawn");
		await reported("[subagent reader answered] done");
		assert.deepEqual(requests().find((r) => r.last === "@spawn")?.tools, ["red_label", "subagent"]);
		assert.deepEqual(requests().find((r) => r.last === "child")?.tools, ["red_label"]);
	});

	it("withdraws a follow-up waiting when Use is withheld and reports it; the subagent never gets it (Opus S2)", async () => {
		const script = [
			spawn("@spawn", "child-start"),
			runs("child-start", "touch started; until [ -e gate ]; do sleep 0.02; done; echo first done"),
			says("first done", "first answer"),
			on("@queue", "send", { message: "queued message", followUp: true }),
			says("", "ok"),
		];
		const held = [login("login", "faux", script), coding(), subagents()];
		const { ask, control } = await start(held);
		await ask("@spawn");
		await started();
		await ask("@queue");
		await waiting(1);
		control.hold([held[0]!, held[1]!, subagents(false)]);
		await writeFile(join(folder, "gate"), "");
		await reported("[subagent reader answered] first answer");
		await eventually(
			() =>
				requests().filter(({ last }) => last.startsWith("[subagent reader failed: the message was withdrawn"))
					.length,
			(count) => count === 1,
			5000,
		);
		assert.ok(!requests().some(({ last }) => last.includes("queued message")));
	});

	it("takes two partial configurations in one model round both (Astra, must 4)", async () => {
		const model = "faux-b/faux-b-model";
		const script = [
			spawn("@spawn", "initial"),
			says("initial", "done"),
			{
				when: "@both",
				reply: [...on("", "configure", { model }).reply, ...on("", "configure", { tools: ["read"] }).reply],
			},
			on("@status", "status"),
			says("", "ok"),
		];
		const { ask } = await start([login("a", "faux-a", script), login("b", "faux-b", []), coding(), subagents()]);
		await ask("@spawn");
		await reported("[subagent reader answered] done");
		await ask("@both");
		await ask("@status");
		const [
			{
				subagents: [reader],
			},
		] = statuses() as [{ subagents: [{ model: string; tools: string[] }] }];
		assert.deepEqual({ model: reader.model, tools: reader.tools }, { model, tools: ["read"] });
	});

	it("gives a running subagent's next step its new model and tools (Astra, round 1 of the port)", async () => {
		const script = [
			spawn("@spawn", "start slow"),
			runs("start slow", "touch started; until [ -e gate ]; do sleep 0.02; done; echo continued"),
			on("@change", "configure", { model: "faux-b/faux-b-model", tools: [] }),
			says("", "ok"),
		];
		const { ask } = await start([
			login("a", "faux-a", script),
			login("b", "faux-b", [says("continued", "done")]),
			coding(),
			subagents(),
		]);
		await ask("@spawn");
		await started();
		await ask("@change");
		await writeFile(join(folder, "gate"), "");
		await reported("[subagent reader answered] done");
		const next = requests().find((r) => r.last.trim() === "continued");
		assert.deepEqual([next?.provider, next?.tools], ["faux-b", []]);
	});

	it("keeps a subagent's queued report when the agent is stopped: its next input takes it (Astra, must 3)", async () => {
		const script = [
			spawn("@spawn", "child-start"),
			runs("child-start", "touch started; until [ -e gate ]; do sleep 0.02; done; echo child-released"),
			says("child-released", "completed"),
			runs("@parent-block", "touch parent-busy; until [ -e parent-gate ]; do sleep 0.02; done"),
			says("", "ok"),
		];
		const { ask, harness } = await start([login("a", "faux", script), coding(), subagents()]);
		const open = await harness();
		await ask("@spawn");
		await started();
		try {
			await open.submit(undefined, { text: "@parent-block", requestId: "block" }, context);
			await eventually(() => existsSync(join(folder, "parent-busy")), Boolean);
			await writeFile(join(folder, "gate"), "");
			await eventually(
				() => open.durable.inspect(context),
				(info) =>
					info.submissions.some(
						(s) => s.status === "queued" && s.requestId?.startsWith("subagent-report:") === true,
					),
			);
			const parent = await open.durable.root(context);
			await parent.abort(context);
			await ask("next input");
			assert.equal(requests().filter((r) => r.last === "[subagent reader answered] completed").length, 1);
		} finally {
			await writeFile(join(folder, "parent-gate"), "");
		}
	});

	it("never leaves an archived subagent running after a send and an archive in one round (Astra, must 2)", async () => {
		const script = [
			spawn("@spawn", "first task"),
			says("first task", "ready"),
			{ when: "@both", reply: [...on("", "send", { message: "second task" }).reply, ...on("", "archive").reply] },
			runs("second task", "touch started; until [ -e gate ]; do sleep 0.02; done"),
			on("@status", "status"),
			says("", "ok"),
		];
		const { ask } = await start([login("a", "faux", script), coding(), subagents()]);
		await ask("@spawn");
		await reported("[subagent reader answered] ready");
		await ask("@both");
		await ask("@status");
		const [
			{
				subagents: [reader],
			},
		] = statuses() as [{ subagents: [{ working: boolean; archived?: true }] }];
		assert.ok(!reader.archived || !reader.working, JSON.stringify(reader));
	});

	it("shows the session's subagents in every top-level branch (Astra, round 1 of the port)", async () => {
		const script = [
			spawn("@spawn", "child-task"),
			says("child-task", "ready"),
			calls("@all", "subagent", { action: "status" }),
			says("", "ok"),
		];
		const { ask, harness } = await start([login("a", "faux", script), subagents()]);
		await ask("@spawn");
		await reported("[subagent reader answered] ready");
		const open = await harness();
		const root = await open.durable.root(context);
		const entry = (await root.entries({}, 1, undefined, context)).items[0]!;
		const branch = await root.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
		await open.submit(String(branch.id), { text: "@all", requestId: "branch" }, context);
		await branch.waitForIdle(context);
		const [{ subagents: children }] = statuses() as [{ subagents: { name: string }[] }];
		assert.deepEqual(
			children.map((c) => c.name),
			["reader"],
		);
	});

	it("refuses a second reader from a duplicate spawn in one round and from an archived name (Astra)", async () => {
		const duplicate = { when: "@two", reply: [...spawn("", "work one").reply, ...spawn("", "work two").reply] };
		const script = [
			duplicate,
			says("work one", "done"),
			says("work two", "done"),
			on("@archive", "archive"),
			spawn("@reuse", "work three"),
			says("", "ok"),
		];
		const { ask } = await start([login("a", "faux", script), subagents()]);
		await ask("@two");
		await reported("[subagent reader answered] done");
		await ask("@archive");
		await ask("@reuse");
		assert.equal(requests().filter((r) => ["work one", "work two", "work three"].includes(r.last)).length, 1);
		assert.match(requests().at(-1)?.last ?? "", /reader exists already/);
	});

	it("shows the thinking level the model runs at (Astra, round 1 of the port)", async () => {
		const script = [
			spawn("@spawn", "child-task", { thinkingLevel: "max" }),
			says("child-task", "done"),
			on("@named", "status"),
			says("", "ok"),
		];
		// The faux login's model has no reasoning: only off.
		const { ask } = await start([login("a", "faux", script), subagents()]);
		await ask("@spawn");
		await reported("[subagent reader answered] done");
		await ask("@named");
		const [
			{
				subagents: [reader],
			},
		] = statuses() as [{ subagents: [{ thinkingLevel: string }] }];
		assert.equal(reader.thinkingLevel, "off");
	});

	it("reports an answer two senders' messages share to each of them once (Astra, round 2 of the port)", async () => {
		const script = [
			spawn("@spawn", "root task"),
			runs("root task", "touch started; until [ -e gate ]; do sleep 0.02; done; echo ready"),
			on("@steer", "send", { message: "branch task" }),
			says("branch task", "joint result"),
			says("", "ok"),
		];
		const { ask, harness } = await start([login("a", "faux", script), coding(), subagents()]);
		await ask("@spawn");
		await started();
		const open = await harness();
		const root = await open.durable.root(context);
		const entry = (await root.entries({}, 1, undefined, context)).items[0]!;
		const branch = await root.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
		await open.submit(String(branch.id), { text: "@steer", requestId: "branch" }, context);
		await branch.waitForIdle(context);
		await eventually(
			() => open.durable.inspect(context),
			(info) => info.submissions.some((s) => s.status === "queued" && s.requestId?.startsWith("subagent:") === true),
		);
		await writeFile(join(folder, "gate"), "");
		await eventually(
			() => requests(),
			(rs) => rs.some((r) => r.last === "[subagent reader answered] joint result"),
		);
		await eventually(
			() => open.durable.inspect(context),
			(info) => info.tasks.length === 0 && info.submissions.length === 0,
		);
		const counts = await Promise.all(
			[root, branch].map(
				async (chat) =>
					(await chat.entries({}, 100, undefined, context)).items.filter(
						(e) =>
							e.conversationId === chat.id &&
							e.model?.some(
								(m) =>
									m.role === "user" &&
									JSON.stringify(m.content).includes("[subagent reader answered] joint result"),
							),
					).length,
			),
		);
		assert.deepEqual(counts, [1, 1]);
	});

	it("leaves work sent after an archive's commit running when the archive's abort comes (Astra, round 2 of the port)", async () => {
		const script = [
			spawn("@spawn", "initial"),
			says("initial", "idle"),
			on("@new", "send", { message: "restored task" }),
			runs("restored task", "touch started; until [ -e gate ]; do sleep 0.02; done; echo continued"),
			says("continued", "new result"),
			says("", "ok"),
		];
		const { ask, harness } = await start([login("a", "faux", script), coding(), subagents()]);
		await ask("@spawn");
		await reported("[subagent reader answered] idle");
		const { durable } = await harness();
		const root = await durable.root(context);
		// Pause exactly between archive's durable transition and child abort; use real Durable for both.
		const paused = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const archiveTool = subagentsPart.part([subagents().held], SESSION).extension!.tools![0]!;
		const api = {
			conversationId: root.id,
			commit: durable.commit.bind(durable),
			conversation: async (id: typeof root.id) => {
				paused.resolve();
				await resume.promise;
				return durable.conversation(id, context);
			},
		};
		const archiving = archiveTool.execute({ action: "archive", name: "reader" } as never, api as never, context);
		try {
			await paused.promise;
			await ask("@new");
			await started();
		} finally {
			resume.resolve();
			await archiving;
			await writeFile(join(folder, "gate"), "");
		}
		await eventually(
			() => durable.inspect(context),
			(info) => info.tasks.length === 0 && info.submissions.length === 0,
		);
		assert.deepEqual(
			requests()
				.filter((r) => r.last.startsWith("[subagent reader "))
				.map((r) => r.last),
			["[subagent reader answered] idle", "[subagent reader answered] new result"],
		);
	});

	it("gives each follow-up its own sender's tools, in the order sent (Astra, round 2 of the port)", async () => {
		const script = [
			spawn("@spawn", "busy work"),
			runs("busy work", "touch started; until [ -e gate ]; do sleep 0.02; done; echo released"),
			on("@one", "send", { message: "first follow up", followUp: true }),
			on("@two", "send", { message: "second follow up", followUp: true }),
			says("first follow up", "one done"),
			says("second follow up", "two done"),
			says("", "ok"),
		];
		const { ask, harness } = await start(
			[login("a", "faux", script), coding(), subagents(), other("test.label", "label")],
			[{ kind: "test.label", tools: [testTool("alpha_label"), testTool("beta_label")] }],
		);
		await ask("@spawn");
		await started();
		const { durable, ...open } = await harness();
		const root = await durable.root(context);
		const entry = (await root.entries({}, 1, undefined, context)).items[0]!;
		const branch = await root.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
		for (const [sender, label] of [
			[root, "alpha_label"],
			[branch, "beta_label"],
		] as const) {
			const tools = (await sender.agent(context)).tools.filter((t) => t.name === "subagent" || t.name === label);
			await durable.commit((tx) => configure(tx, sender.id, { tools }), context);
		}
		// The follow-ups wait in their reporters, in the order sent, until the subagent's current work answered.
		await ask("@one");
		await waiting(1);
		await open.submit(String(branch.id), { text: "@two", requestId: "two" }, context);
		await branch.waitForIdle(context);
		await waiting(2);
		await writeFile(join(folder, "gate"), "");
		await reported("[subagent reader answered] two done");
		const offers = (text: string) =>
			requests()
				.find((r) => r.last === text)
				?.tools.filter((t) => t.endsWith("_label"));
		assert.deepEqual(
			[offers("@one"), offers("@two"), offers("first follow up"), offers("second follow up")],
			[["alpha_label"], ["beta_label"], ["alpha_label"], ["beta_label"]],
		);
	});
});
