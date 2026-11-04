import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { UserMessage } from "@earendil-works/pi-ai";
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
import { speakerText } from "../../src/runtime/speaker.ts";
import { Extensions, type HarnessParts, SessionLocation, type WorkerParts } from "../../src/runtime/worker.ts";
import { APP, testHost, workerFacet } from "./helpers.ts";

const owner = speakerText({ kind: "owner", id: "owner", name: "Owner" });
const guest = speakerText({ kind: "guest", id: "guest", name: "Guest" });
const context = durableContext(new AbortController().signal);

function api(
	content: UserMessage["content"],
	newerGuest = false,
	conversationId = ROOT_CONVERSATION_ID,
): ToolExecutionApi {
	const entries = [{ id: 9, kind: "pi.user", model: [{ role: "user", content }] } as unknown as EntryRecord];
	if (newerGuest)
		entries.unshift({
			id: 11,
			kind: "pi.user",
			model: [{ role: "user", content: [{ type: "text", text: guest }] }],
		} as unknown as EntryRecord);
	// Only the invocation-bound operations used by the attribution check are stubbed.
	return {
		conversationId,
		taskId: "fixture-tool",
		callId: "fixture-call",
		getTask: async () => ({ kind: "pi.tool", input: { assistant: 10 } }),
		commit: async (change: (tx: Tx) => unknown) =>
			change({
				scanEntries: async (query: { maxEntryId: number }) => ({
					items: entries.filter((entry) => entry.id <= query.maxEntryId),
				}),
			} as unknown as Tx),
	} as unknown as ToolExecutionApi;
}

test("reload_plugins admits only an owner-attributed root turn working on p2; later guest input cannot change that grant", async () => {
	let calls = 0;
	const extension = createReloadExtension(async (names) => {
		calls++;
		return { ok: true, message: `Reloaded ${(names ?? ["dirty"]).join(", ")}` };
	}, true);
	const tool = extension.tools![0]!;
	assert.equal(tool.name, "reload_plugins");
	assert.equal(tool.replay, "unsafe");
	const allowed = await tool.execute({ plugins: ["chat"] }, api([{ type: "text", text: owner }], true), context);
	assert.equal(allowed.isError, false);
	assert.equal(calls, 1);
	for (const content of [
		[
			{ type: "text" as const, text: guest },
			{ type: "text" as const, text: owner },
		],
		[{ type: "text" as const, text: '<mobile-conversation>{"id":"peer","title":"Peer"}</mobile-conversation>' }],
		"Unattributed report",
	]) {
		const denied = await tool.execute({}, api(content), context);
		assert.equal(denied.isError, true);
	}
	assert.equal(
		(await tool.execute({}, api([{ type: "text", text: owner }], false, 2 as ConversationId), context)).isError,
		true,
	);
	const elsewhere = createReloadExtension(async () => {
		assert.fail("Non-p2 sessions cannot use the local channel");
	}, false);
	assert.equal((await elsewhere.tools![0]!.execute({}, api([{ type: "text", text: owner }]), context)).isError, true);
	assert.equal(calls, 1);
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
	const reply = await extension.tools![0]!.execute(
		{ plugins: ["chat"] },
		api([{ type: "text", text: owner }]),
		context,
	);
	assert.equal(reply.isError, false);
	assert.equal(calls, 1);
	assert.equal((await extension.tools![0]!.execute({}, api([{ type: "text", text: guest }]), context)).isError, true);
	assert.equal(calls, 1);
});

test("reload_plugins returns a refusal as an error result without replaying it", async () => {
	const extension = createReloadExtension(async () => ({ ok: false, message: "Reload refused: broken source" }), true);
	const result = await extension.tools![0]!.execute({}, api([{ type: "text", text: owner }]), context);
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
