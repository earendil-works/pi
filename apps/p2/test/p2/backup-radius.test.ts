// Backup to the Radius this p2 is signed in to (`P2_BACKUP=radius`), against the local Radius stand-in: no sign-in of
// its own (the connection's token), the server's ID as the device of every slot and in the server store's name, a
// session's backup that restores equal to the session, and a refusal (403: the feature off) that stops uploads.

import assert from "node:assert/strict";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { openStore, type Store, sqliteBackend } from "@earendil-works/chord";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { FileSyncStateStore, pullSession } from "@earendil-works/chord/sync";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Backup } from "../../plugins/backup/contract.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { readRadiusConfig } from "../../plugins/radius/brain.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { RadiusSyncRemote } from "../../plugins/sync/radius-remote.ts";
import { backupFiles } from "../../src/runtime/backup.ts";
import { clientHost, holdIn, localOwner, until } from "./helpers.ts";
import { radiusFixture } from "./radius-fixture.ts";

const answered = (view: ConversationView | null | undefined) =>
	JSON.stringify(view?.entries ?? []).includes("Echo:") && !(view?.docs["pi.live"] as LiveState | undefined)?.run;

async function contents(store: Store): Promise<string> {
	const parts: string[] = [];
	for await (const part of store.export(BACKGROUND_CONTEXT))
		if (part.kind !== "manifest") parts.push(JSON.stringify(part));
	return parts.sort().join("\n");
}

/** `P2_BACKUP=radius` for the server the fixture starts (workers inherit it), restored after the test. */
function backupToRadius(t: TestContext): void {
	const previous = process.env.P2_BACKUP;
	process.env.P2_BACKUP = "radius";
	t.after(() => {
		if (previous === undefined) delete process.env.P2_BACKUP;
		else process.env.P2_BACKUP = previous;
	});
}

test("backs up to the Radius it is signed in to, as its server, and restores a session from there", async (t) => {
	backupToRadius(t);
	const { server, radius, directory } = await radiusFixture(t);
	const config = await readRadiusConfig(directory);
	assert(config);
	const backup = await server.host.get(Backup, {}, BACKGROUND_CONTEXT);
	t.after(() => backup.release());
	assert.equal(backup.device.value, config.serverId, "the device is the Radius server's ID");

	const owner = clientHost(await localOwner(server));
	const sessions = await holdIn(owner, Sessions, {}, "owner");
	const session = await sessions.create({ cwd: directory, title: "On Radius" }, BACKGROUND_CONTEXT);
	const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
	await chat.send({ text: "hello radius", requestId: crypto.randomUUID() }, BACKGROUND_CONTEXT);
	await until(chat.view, answered);
	chat.release();
	const name = `session-${session.id}`;
	await until(
		backup.statuses,
		(value) =>
			value?.[name]?.state === "synced" && (value[name]?.syncedHead ?? 0) > 0 && value.server?.state === "synced",
		20_000,
	);

	// On Radius: the server's store under its server's name, the session's, every slot recorded as this server's.
	const stored = [...radius.sync.stores.keys()].sort();
	assert.deepEqual(stored, [`server-${config.serverId}`, name].sort());
	for (const { slots } of radius.sync.stores.values())
		for (const slot of slots) assert.equal(slot.device, config.serverId);
	assert.ok(
		radius.sync.tokens.every((token) => token === "Bearer fixture-token"),
		"the connection's own token",
	);

	// The session's backup restores from Radius into a store equal to the session's.
	sessions.release();
	await owner.close(BACKGROUND_CONTEXT);
	await server.close();
	const remote = new RadiusSyncRemote(async () => ({
		gateway: radius.gateway,
		serverId: config.serverId,
		token: "fixture-token",
	}));
	const restored = await pullSession({
		sessionId: name,
		store: remote,
		local: { kind: "empty", backend: sqliteBackend(await openNodeSqliteDatabase(":memory:")) },
		state: new FileSyncStateStore(backupFiles(directory), join(directory, "restore-state")),
		context: BACKGROUND_CONTEXT,
	});
	const original = await openStore(
		sqliteBackend(await openNodeSqliteDatabase(join(directory, "sessions", session.id, "store.sqlite"))),
		BACKGROUND_CONTEXT,
	);
	try {
		assert.equal(restored.head, original.lastSeq);
		assert.equal(await contents(restored.store), await contents(original));
	} finally {
		await restored.store.close(BACKGROUND_CONTEXT);
		await original.close(BACKGROUND_CONTEXT);
	}
});

test("stops uploading when Radius refuses sync (403: the feature off), instead of retrying", async (t) => {
	backupToRadius(t);
	const { server, radius } = await radiusFixture(t, Buffer.from("body"), {}, {});
	radius.sync.refuse = 403;
	const backup = await server.host.get(Backup, {}, BACKGROUND_CONTEXT);
	t.after(() => backup.release());
	const stopped = await until(
		backup.statuses,
		(value) => value?.server?.state === "error" && (value.server.error ?? "").includes("stopped until a restart"),
		20_000,
	);
	assert.match(stopped?.server?.error ?? "", /403/);
	// No retries after the stop: the request count stays.
	const requests = radius.sync.tokens.length;
	await new Promise((resolve) => setTimeout(resolve, 3000));
	assert.equal(radius.sync.tokens.length, requests);
});
