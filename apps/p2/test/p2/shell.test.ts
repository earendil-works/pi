// User shell commands (`!cmd`/`!!cmd`, p2-tui-port.md section 10.8) on a bare session host: a real Durable harness
// with the fake provider and a real local execution environment, the chat worker facet, principals over memory links.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type ConversationId,
	type ConversationView,
	createRegistry,
	Harness as DurableHarness,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT, follow } from "@p2/app/v1";
import { Chat, SHELL_BUSY } from "../../plugins/chat/contract.ts";
import chatWorker from "../../plugins/chat/worker.ts";
import { WorkerModels } from "../../plugins/models/contract.ts";
import { createP2Models } from "../../plugins/models/models.ts";
import { StatusReport } from "../../plugins/status/contract.ts";
import { type Host, Session } from "../../src/runtime/chord.ts";
import { durableContext } from "../../src/runtime/durable.ts";
import { SHELL_ENTRY, type ShellData, shellTail } from "../../src/runtime/shell.ts";
import { type HarnessParts, type Liveness, SessionLocation } from "../../src/runtime/worker.ts";
import { buildTranscript } from "../../src/web/transcript.ts";
import { wholeView } from "../fixtures/whole-view.ts";
import { expectChord, holdIn, testHost, until, workerFacet } from "./helpers.ts";

const OWNER = { kind: "owner", access: "local" } as const;
const ALICE = { kind: "guest", id: "alice", name: "Alice", home: "s1", sessions: { s1: "full" }, revision: 1 } as const;
const BOB = { kind: "guest", id: "bob", name: "Bob", home: "s1", sessions: { s1: "view" }, revision: 1 } as const;
const where = { session: "s1", conversation: 1 };

async function shellHost() {
	const directory = mkdtempSync(join(tmpdir(), "p2-shell-"));
	const context = durableContext(new AbortController().signal);
	const durable = await DurableHarness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{ models: createP2Models(true), registry: createRegistry() },
		context,
	);
	await durable.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: directory } });
	durable.resume();
	const env = new NodeExecutionEnv({ cwd: directory });
	let calls = 0;
	let host: Host | undefined;
	const fixture = await testHost({
		address: Session({ id: "s1" }),
		kind: "worker",
		facets: [
			workerFacet({
				harness: {
					durable,
					environments: {
						session: { cwd: directory, env: null },
						locate: async () => ({ cwd: directory, env: null }),
						at: async () => env,
					},
					relocate: async () => {},
				} as unknown as HarnessParts,
				worker: {
					// Calls and running commands are active calls (a move or a clone waits for them).
					liveness: {
						add: (kind: string, delta: number) => {
							if (kind === "activeCalls") calls += delta;
						},
						call: async <T>(fn: () => Promise<T>) => {
							calls++;
							try {
								return await fn();
							} finally {
								calls--;
							}
						},
					} as unknown as Liveness,
					location: new SessionLocation({ cwd: directory, env: null }),
				},
				host: () => host!,
			}),
			chatWorker,
		],
		stubs: [
			// No server here: the worker's status pushes go nowhere.
			[StatusReport, { push: async () => null }],
			// No settings.json: the owner's entries carry the default name.
			[WorkerModels, (_input, _principal, self) => ({ settings: self.state({}) })],
		],
	});
	host = fixture.host;
	return {
		...fixture,
		durable,
		directory,
		activeCalls: () => calls,
		close: async () => {
			await fixture.close();
			await durable.close(context).catch(() => {});
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

type View = ConversationView | null | undefined;
const shells = (view: View): { data: ShellData; model: unknown }[] =>
	(view?.entries ?? [])
		.filter((entry) => entry.kind === SHELL_ENTRY)
		.map((entry) => ({ data: entry.data as unknown as ShellData, model: entry.model }));
const answered = (view: View) => (view?.entries ?? []).some((entry) => entry.model?.[0]?.role === "assistant");

describe("user shell commands", () => {
	it("`!` places the output in the context without a run; `!!` keeps it out", async (t) => {
		const fixture = await shellHost();
		t.after(() => fixture.close());
		const owner = await holdIn(fixture.client(OWNER), Chat, where, "participant");
		if (owner.variant !== "participant") return;
		// A state's value is current while subscribed.
		t.after(follow(owner.view, () => {}));
		await owner.shell(
			{ command: "echo out; echo err >&2; exit 3", includeInContext: true, requestId: "1" },
			BACKGROUND_CONTEXT,
		);
		let view = await until(owner.view, (next) => shells(next).length === 1);
		const [first] = shells(view);
		assert.equal(first?.data.command, "echo out; echo err >&2; exit 3");
		assert.match(first?.data.output ?? "", /out/);
		assert.match(first?.data.output ?? "", /err/);
		assert.equal(first?.data.exitCode, 3);
		assert.deepEqual(first?.data.author, { kind: "owner", id: "owner", name: "Owner" });
		assert.equal(first?.data.cancelled, false);
		assert.match(JSON.stringify(first?.model), /Ran `echo out; echo err >&2; exit 3`/);
		assert.match(JSON.stringify(first?.model), /Command exited with code 3/);
		assert(!answered(view), "a command never starts a run");
		// The live state clears once the entry is placed.
		await until(owner.liveShell, (value) => value === null);

		await owner.shell({ command: "echo private", includeInContext: false, requestId: "2" }, BACKGROUND_CONTEXT);
		view = await until(owner.view, (next) => shells(next).length === 2);
		assert.equal(shells(view)[1]?.data.includeInContext, false);
		assert.equal(shells(view)[1]?.model, undefined, "`!!` is display-only");
		// The model's next context has the `!` command and not the `!!` one.
		const context = durableContext(new AbortController().signal);
		const conversation = await fixture.durable.conversation(1 as ConversationId, context);
		const messages = JSON.stringify((await conversation!.context(context)).messages);
		assert.match(messages, /Ran `echo out; echo err >&2; exit 3`/);
		assert.doesNotMatch(messages, /echo private/);
		// A retried call with the same request ID runs once.
		const again = await owner.shell(
			{ command: "echo private", includeInContext: false, requestId: "2" },
			BACKGROUND_CONTEXT,
		);
		// The command's ID is the caller's request ID.
		assert.equal(again.shellId, "2");
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(shells(owner.view.value).length, 2);
		// The web shows it as a plain notice: `$ command`, the output fenced, how it ended.
		const transcript = buildTranscript(wholeView(owner.view.value!));
		const marker = transcript.items.find((item) => item.type === "marker" && item.label.startsWith("$ echo out"));
		assert(marker?.type === "marker");
		assert.match(marker.detail ?? "", /```\nout\nerr\n```|```\nerr\nout\n```/);
		assert.match(marker.detail ?? "", /Exited with code 3/);
		assert(!transcript.items.some((item) => item.type === "user"), "never shown as a person's message");
	});

	it("one command at a time; Escape cancels (its author or the owner); full guests run, viewers watch", async (t) => {
		const fixture = await shellHost();
		t.after(() => fixture.close());
		const [alice, owner, bob] = await Promise.all([
			holdIn(fixture.client(ALICE), Chat, where, "participant"),
			holdIn(fixture.client(OWNER), Chat, where, "participant"),
			// View-only guests cannot run commands.
			holdIn(fixture.client(BOB), Chat, where, "viewer"),
		]);
		const { shellId } = await alice.shell(
			{
				command: "echo started; sleep 20; echo late",
				includeInContext: true,
				requestId: "a",
			},
			BACKGROUND_CONTEXT,
		);
		// Everyone sees it run, with its output so far. It is a job (the worker stays up) and one active call while it
		// runs (a move or a clone waits for it).
		const live = await until(bob.liveShell, (value) => Boolean(value?.running && value.output.includes("started")));
		assert.deepEqual(live?.author, { kind: "guest", id: "alice", name: "Alice" });
		assert.equal(fixture.host.activity.value.jobs, 1);
		assert.equal(fixture.activeCalls(), 1);
		await assert.rejects(
			owner.shell({ command: "true", includeInContext: true, requestId: "b" }, BACKGROUND_CONTEXT),
			(error: Error) => error.message.includes(SHELL_BUSY),
		);
		// The owner may cancel anyone's command; a cancelled one is placed as cancelled.
		assert.deepEqual(await owner.abortShell({ shellId }, BACKGROUND_CONTEXT), { aborted: true });
		const view = await until(owner.view, (next) => shells(next).length === 1);
		const [cancelled] = shells(view);
		assert.equal(cancelled?.data.cancelled, true);
		assert.doesNotMatch(cancelled?.data.output ?? "", /late/);
		assert.deepEqual(cancelled?.data.author, { kind: "guest", id: "alice", name: "Alice" });
		await until(owner.liveShell, (value) => value === null);
		await until(fixture.host.activity, (activity) => activity.jobs === 0);
		assert.equal(fixture.activeCalls(), 0);
		// Only its author or the owner cancels a running command.
		const second = await owner.shell(
			{ command: "sleep 20", includeInContext: false, requestId: "c" },
			BACKGROUND_CONTEXT,
		);
		await until(alice.liveShell, (value) => Boolean(value?.running));
		await expectChord(alice.abortShell({ shellId: second.shellId }, BACKGROUND_CONTEXT), "forbidden");
		assert.deepEqual(await owner.abortShell({ shellId: second.shellId }, BACKGROUND_CONTEXT), { aborted: true });
		await until(owner.view, (next) => shells(next).length === 2);
	});

	it("keeps the tail within the bash tool's limits", () => {
		const lines = Array.from({ length: 2500 }, (_, index) => `line ${index}`).join("\n");
		const tail = shellTail(lines);
		assert.equal(tail.truncated, true);
		assert.equal(tail.text.split("\n").length, 2000);
		assert.match(tail.text, /^line 500\n/);
		const long = shellTail("x".repeat(60 * 1024));
		assert.equal(long.truncated, true);
		assert.equal(long.text.length, 50 * 1024);
		assert.deepEqual(shellTail("short"), { text: "short", truncated: false });
	});
});
