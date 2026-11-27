// The machine end to end (`testServer`: the real server, a session's worker as a process, the tests' faux login): a
// session's agent runs its tools on this device's machine, in the session's folder, with Work here; with Work here
// withheld from the agents on the machine, the harness's next step has no environment, and nothing falls back (round
// 1, must 3; 1172 tests 1 and 4); withheld while a command runs, the command finishes and the run's next step has none
// (Astra, round 5); `location_move` moves the agent's conversation (by the machine's name or id), refused for a
// relative folder or a machine not here; a subagent works at its caller's location until it moves its own.

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, SessionObject, Transcript, until, withGranted } from "@earendil-works/p3/v1";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { FauxRequests, type Step } from "../../../test/plugins/faux-login/contract.ts";
import { newSession, piOf, scriptFaux, thisDevice } from "../../../test/support.ts";
import { eventually, within } from "../../../test/until.ts";
import { ThingsStore } from "../../things/contract.server.ts";

/** The tests' faux login, a plugin under test of a root of its own. */
const FAUX = fileURLToPath(new URL("../../../test/plugins/faux-login/", import.meta.url));

/** A script that runs `pwd` with bash on `@go`, then answers what the tool answered. */
const PWD: Step[] = [
	{ when: "@go", reply: [{ kind: "tool", name: "bash", args: JSON.stringify({ command: "pwd" }) }] },
	{ when: "", reply: [{ kind: "text", text: "done" }] },
];

describe("a session's agent on this device's machine", () => {
	let t: TestServer;
	let folder: string;

	before(async () => {
		folder = await realpath(await mkdtemp(join(tmpdir(), "p3-machine-e2e-")));
		t = await testServer({ plugins: [FAUX] }, context);
	});

	after(async () => {
		await t.close(context);
		await rm(folder, { recursive: true, force: true });
	});

	/** Runs `@go` in a new session in `folder` and answers what its bash call answered (the login's second request). */
	async function run(title: string): Promise<string> {
		const client = await t.client(context);
		const id = await newSession(client, title, context, { folder });
		await scriptFaux(t.host, id, PWD, context);
		return client.root(async (ctx) => {
			const transcript = withGranted(await ctx.get(Transcript, { session: id }), "send")!;
			await transcript.send({ text: "@go", requestId: "go" }, ctx);
			const held = await ctx.get(SessionObject, { workspace: id, thing: id });
			await until(held.row, (row) => row.state === "working", within("working", ctx, 10_000));
			await until(held.row, (row) => row.state === "settled", within("settled", ctx, 10_000));
			const requests = (await ctx.get(FauxRequests, { session: id })).requests;
			return (await until(requests, (seen) => seen.length === 2, within("the answer", ctx))).at(-1)!.last;
		}, context);
	}

	/**
	 * Sends `@go` in a new session in `folder` whose login follows `steps`, and answers the last message of every request
	 * the login got, once `done` holds for them.
	 */
	async function scripted(title: string, steps: Step[], done: (lasts: string[]) => boolean): Promise<string[]> {
		const client = await t.client(context);
		const id = await newSession(client, title, context, { folder });
		await scriptFaux(t.host, id, steps, context);
		return client.root(async (ctx) => {
			const transcript = withGranted(await ctx.get(Transcript, { session: id }), "send")!;
			await transcript.send({ text: "@go", requestId: "go" }, ctx);
			const requests = (await ctx.get(FauxRequests, { session: id })).requests;
			const seen = await until(requests, (all) => done(all.map(({ last }) => last)), within("the run", ctx, 20_000));
			return seen.map(({ last }) => last);
		}, context);
	}

	/** A tool call of `name` with `args`. */
	const call = (name: string, args: object) => ({ kind: "tool" as const, name, args: JSON.stringify(args) });

	// The agent's own move (decision 24, ERNDL-704 push 4; the tool is the machine part's).
	it("moves its conversation with location_move, by the machine's name, and runs its next bash there", async () => {
		const moved = await realpath(await mkdtemp(join(tmpdir(), "p3-machine-moved-")));
		try {
			const machine = await thisDevice(await t.client(context), context);
			const lasts = await scripted(
				"move",
				[
					{ when: "@go", reply: [call("location_move", { machine: hostname(), folder: moved })] },
					{ when: `"folder":"${moved}"`, reply: [call("bash", { command: "pwd" })] },
					{ when: "", reply: [{ kind: "text", text: "done" }] },
				],
				(all) => all.some((last) => last.startsWith(`${moved}\n`)),
			);
			assert.deepEqual(JSON.parse(lasts[1]!), { machine, folder: moved }, "answered with the machine's id");
		} finally {
			await rm(moved, { recursive: true, force: true });
		}
	});

	it("is refused a move to a folder that is not a full path, or to a machine not here, and stays where it is", async () => {
		const lasts = await scripted(
			"refused",
			[
				{ when: "@go", reply: [call("location_move", { machine: hostname(), folder: "relative/path" })] },
				{ when: "full path", reply: [call("location_move", { machine: "elsewhere", folder: "/tmp" })] },
				{ when: "no machine elsewhere", reply: [call("bash", { command: "pwd" })] },
				{ when: "", reply: [{ kind: "text", text: "done" }] },
			],
			(all) => all.length >= 4,
		);
		assert.match(lasts[1]!, /full path/);
		assert.match(lasts[2]!, /no machine elsewhere here/);
		assert.equal(lasts[3], `${folder}\n`, "still in the session's folder");
	});

	it("gives a subagent its caller's location until it moves its own conversation", async () => {
		const [first, own] = [
			await realpath(await mkdtemp(join(tmpdir(), "p3-machine-first-"))),
			await realpath(await mkdtemp(join(tmpdir(), "p3-machine-own-"))),
		];
		try {
			const machine = await thisDevice(await t.client(context), context);
			const lasts = await scripted(
				"subagent",
				[
					{ when: "@go", reply: [call("location_move", { machine, folder: first })] },
					{
						when: `"folder":"${first}"`,
						reply: [call("subagent", { action: "spawn", name: "helper", message: "@helper" })],
					},
					{ when: "@helper", reply: [call("bash", { command: "pwd" })] },
					{ when: `${first}\n`, reply: [call("location_move", { machine, folder: own })] },
					{ when: `"folder":"${own}"`, reply: [call("bash", { command: "pwd" })] },
					{ when: "", reply: [{ kind: "text", text: "done" }] },
				],
				(all) => all.some((last) => last.startsWith(`${own}\n`)),
			);
			// The subagent ran in its caller's folder first, then in its own.
			assert.ok(lasts.some((last) => last.startsWith(`${first}\n`)));
			assert.ok(lasts.some((last) => last.startsWith(`${own}\n`)));
		} finally {
			await rm(first, { recursive: true, force: true });
			await rm(own, { recursive: true, force: true });
		}
	});

	// Astra, round 5: withholding Work here does not cut the command under way; the run's next step has no machine.
	it("lets a command under way finish when Work here is withheld, and gives the run's next step no environment", async () => {
		const client = await t.client(context);
		const id = await newSession(client, "midrun", context, { folder });
		const [pi, machine] = [await piOf(client, context), await thisDevice(client, context)];
		const bash = (command: string) => ({ kind: "tool" as const, name: "bash", args: JSON.stringify({ command }) });
		await scriptFaux(
			t.host,
			id,
			[
				{ when: "@go", reply: [bash("touch started; until test -f go; do sleep 0.03; done; echo finished-first")] },
				{ when: "finished-first", reply: [bash("pwd")] },
				{ when: "", reply: [{ kind: "text", text: "done" }] },
			],
			context,
		);
		/** Gives or withholds (`gives`) the agents' Work here on this device's machine in Pi. */
		const work = (gives: boolean) =>
			t.host.root(async (ctx) => {
				const things = await ctx.get(ThingsStore, {});
				const party = { kind: "agents" } as const;
				const source = { kind: "plugin", plugin: "test" } as const;
				await things.setTick(
					{
						workspace: pi,
						thing: machine,
						party,
						tick: "work",
						source,
						gives,
					},
					ctx,
				);
			}, context);
		try {
			const seen = await client.root(async (ctx) => {
				const transcript = withGranted(await ctx.get(Transcript, { session: id }), "send")!;
				const requests = (await ctx.get(FauxRequests, { session: id })).requests;
				await transcript.send({ text: "@go", requestId: "go" }, ctx);
				await eventually(
					() => stat(join(folder, "started")),
					(found) => found.isFile(),
				);
				await work(false);
				await writeFile(join(folder, "go"), "");
				return until(requests, (all) => all.length >= 3, within("the third request", ctx, 15_000));
			}, context);
			assert.match(seen[1]!.last, /finished-first/);
			assert.match(seen[2]!.last, /No execution environment/);
		} finally {
			await work(true);
			await rm(join(folder, "started"), { force: true });
			await rm(join(folder, "go"), { force: true });
		}
	});

	it("runs its tools in the session's folder with Work here, and nowhere once Work here is withheld", async () => {
		assert.ok((await run("with")).includes(folder), "with Work here the tool runs in the session's folder");
		const owner = await t.client(context);
		const [pi, machine] = [await piOf(owner, context), await thisDevice(owner, context)];
		await t.host.root(async (ctx) => {
			const things = await ctx.get(ThingsStore, {});
			const grant = {
				workspace: pi,
				thing: machine,
				party: { kind: "agents" },
				tick: "work",
				gives: false,
			} as const;
			await things.setGrants({ source: { kind: "plugin", plugin: "test" }, grants: [grant] }, ctx);
		}, context);
		assert.match(await run("without"), /No execution environment/, "without it there is none, and no fallback");
		assert.deepEqual(t.errors, []);
	});
});
