import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type ConversationId,
	type EntryRecord,
	ROOT_CONVERSATION_ID,
	type ToolExecutionApi,
	type Tx,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { createReloadExtension } from "../../plugins/dev-tools/tool.ts";
import devToolsWorker from "../../plugins/dev-tools/worker.ts";
import { serveDevChannel } from "../../src/hosts/dev-channel.ts";
import { Session } from "../../src/runtime/chord.ts";
import { durableContext, ExtensionSwitches } from "../../src/runtime/durable.ts";
import { PEER_MESSAGE_ENTRY } from "../../src/runtime/entries.ts";
import { INPUT_ENTRY } from "../../src/runtime/input.ts";
import { guardTool } from "../../src/runtime/tool-access.ts";
import { Extensions, type HarnessParts, SessionLocation, type WorkerParts } from "../../src/runtime/worker.ts";
import { APP, testHost, workerFacet } from "./helpers.ts";

/** An input entry's kind and data; its model message is a plain text, which attribution never reads. */
type Input = { kind: string; data?: unknown };
const person = (kind: "owner" | "guest"): Input => ({
	kind: INPUT_ENTRY,
	data: { author: { kind, id: kind, name: kind }, text: "x", attachments: [] },
});
const owner = person("owner");
const guest = person("guest");
const context = durableContext(new AbortController().signal);

/** A tool call's API in a run that placed `inputs`, in conversation `conversationId`. */
function api(inputs: Input[], conversationId = ROOT_CONVERSATION_ID): ToolExecutionApi {
	const entries = inputs.map(
		({ kind, data }, index) =>
			({ id: index + 1, kind, data, model: [{ role: "user", content: "x" }] }) as unknown as EntryRecord,
	);
	// Only the invocation-bound operations used by the requirement checks are stubbed.
	return {
		conversationId,
		taskId: "fixture-tool",
		callId: "fixture-call",
		// No `/tree` branches: conversation 1 is the only top-level conversation.
		snapshot: async (doc: { definition: { kind: string } }) =>
			doc.definition.kind === "pi.live" ? { run: { inputs: entries.map((entry) => entry.id) } } : undefined,
		commit: async (change: (tx: Tx) => unknown) =>
			change({
				submission: async (id: number) => ({ type: "input", entry: id }),
				entry: async (id: number) => entries.find((entry) => entry.id === id),
			} as unknown as Tx),
	} as unknown as ToolExecutionApi;
}

test("reload_plugins admits only a root turn the owner started, working on p2; a guest's steered input takes it away", async () => {
	let calls = 0;
	const extension = createReloadExtension(async (names) => {
		calls++;
		return { ok: true, message: `Reloaded ${(names ?? ["dirty"]).join(", ")}` };
	}, true);
	// As the worker's registry runs it: with its requirements checked.
	const tool = guardTool(extension.tools![0]!);
	assert.equal(tool.name, "reload_plugins");
	assert.equal(tool.replay, "unsafe");
	assert.deepEqual([tool.origin, tool.scope], ["owner", "main"]);
	const allowed = await tool.execute({ plugins: ["chat"] }, api([owner]), context);
	assert.equal(allowed.isError, false);
	assert.equal(calls, 1);
	const peer = (origin?: "owner") => ({
		kind: PEER_MESSAGE_ENTRY,
		data: { from: { id: "peer", title: "Peer" }, text: "x", ...(origin ? { origin } : {}) },
	});
	assert.equal((await tool.execute({}, api([peer("owner")]), context)).isError, false, "the owner's peer message");
	assert.equal(calls, 2);
	for (const inputs of [[guest], [owner, guest], [peer()], [{ kind: "pi.user" }], []]) {
		const denied = await tool.execute({}, api(inputs), context);
		assert.equal(denied.isError, true);
	}
	assert.equal((await tool.execute({}, api([owner], 2 as ConversationId), context)).isError, true);
	const elsewhere = createReloadExtension(async () => {
		assert.fail("Non-p2 sessions cannot use the local channel");
	}, false);
	assert.equal((await guardTool(elsewhere.tools![0]!).execute({}, api([owner]), context)).isError, true);
	assert.equal(calls, 2);
});

test("worker facet registers reload_plugins and the owner tool uses only its own private data-directory channel", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-dev-tool-"));
	let calls = 0;
	const closeChannel = await serveDevChannel(directory, async (command) => {
		calls++;
		assert.deepEqual(command, { action: "reload", plugins: ["chat"] });
		return { ok: true, message: "Reloaded chat" };
	});
	const fixture = await testHost({
		address: Session({ id: "fixture" }),
		kind: "worker",
		facets: [
			workerFacet({
				harness: {} as HarnessParts,
				worker: {
					init: {
						app: APP,
						dataDir: directory,
						fake: true,
						generation: 1,
						plugins: [],
						values: {
							session: {
								id: "fixture",
								cwd: fileURLToPath(new URL("../../", import.meta.url)),
								env: null,
								model: { provider: "faux", modelId: "faux-1" },
								thinkingLevel: "off",
							},
						},
					} as unknown as WorkerParts["init"],
					location: new SessionLocation({ cwd: fileURLToPath(new URL("../../", import.meta.url)), env: null }),
				},
			}),
			devToolsWorker,
		],
	});
	t.after(async () => {
		await fixture.close();
		await closeChannel();
		await rm(directory, { recursive: true, force: true });
	});
	const extension = (await fixture.host.registry(Extensions, BACKGROUND_CONTEXT)).value.get("p2-dev-tools");
	assert(extension);
	const reply = await guardTool(extension.tools![0]!).execute({ plugins: ["chat"] }, api([owner]), context);
	assert.equal(reply.isError, false);
	assert.equal(calls, 1);
	assert.equal((await guardTool(extension.tools![0]!).execute({}, api([guest]), context)).isError, true);
	assert.equal(calls, 1);
});

test("reload_plugins returns a refusal as an error result without replaying it", async () => {
	const extension = createReloadExtension(async () => ({ ok: false, message: "Reload refused: broken source" }), true);
	const result = await extension.tools![0]!.execute({}, api([owner]), context);
	assert.equal(result.isError, true);
	assert.deepEqual(result.output, [{ type: "text", text: "Reload refused: broken source" }]);
});

test("reload_plugins is offered only in dev mode, for a session on this p2 checkout", async (t) => {
	const offered = async (dev: boolean, cwd: string): Promise<boolean | undefined> => {
		const saved = process.env.P2_DEV;
		if (dev) process.env.P2_DEV = "1";
		else delete process.env.P2_DEV;
		try {
			const fixture = await testHost({
				address: Session({ id: "fixture" }),
				kind: "worker",
				facets: [
					workerFacet({
						harness: {} as HarnessParts,
						worker: {
							init: {
								app: APP,
								dataDir: tmpdir(),
								values: { session: { id: "fixture", cwd, env: null } },
							} as unknown as WorkerParts["init"],
							location: new SessionLocation({ cwd, env: null }),
						},
					}),
					devToolsWorker,
				],
			});
			t.after(() => fixture.close());
			await new Promise((resolve) => setTimeout(resolve, 20));
			return (await fixture.host.registry(ExtensionSwitches, BACKGROUND_CONTEXT)).value.get("p2-dev-tools");
		} finally {
			if (saved === undefined) delete process.env.P2_DEV;
			else process.env.P2_DEV = saved;
		}
	};
	const checkout = fileURLToPath(new URL("../../", import.meta.url));
	assert.equal(await offered(true, checkout), true);
	assert.equal(await offered(false, checkout), false);
	assert.equal(await offered(true, tmpdir()), false);
});
