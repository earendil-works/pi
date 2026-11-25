// Backup to the Radius this p2 is signed in to (`P2_BACKUP=radius`), against the local Radius stand-in: no sign-in of
// its own (the connection's token), the server's ID as the device of every slot and in the server store's name, a
// session's backup that restores equal to the session, a refusal (403: the feature off) that stops uploads, and a
// session's backup kept with the account that made it when another person signs in on the machine.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { openStore, type Store, sqliteBackend } from "@earendil-works/chord";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { FileSyncStateStore, pullSession } from "@earendil-works/chord/sync";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Host } from "@p2/app/v1";
import { Backup, type BackupStatus } from "../../plugins/backup/contract.ts";
import { RadiusSyncRemote } from "../../plugins/backup/radius-remote.ts";
import { backupFiles } from "../../plugins/backup/uploader.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { readRadiusConfig } from "../../plugins/radius/brain.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { type P2Server, startServer } from "../../src/hosts/server.ts";
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
		(value) => value?.server?.state === "stopped" && value.server.reason === "refused",
		20_000,
	);
	const status = stopped?.server;
	assert.ok(status?.state === "stopped");
	assert.match(status.error, /403/);
	// No retries after the stop: the request count stays.
	const requests = radius.sync.tokens.length;
	await new Promise((resolve) => setTimeout(resolve, 3000));
	assert.equal(radius.sync.tokens.length, requests);
});

test("keeps a session's backup with the account that made it when another person signs in on the machine", async (t) => {
	backupToRadius(t);
	const { server, radius, directory } = await radiusFixture(t);
	type Status = Record<string, BackupStatus | undefined> | undefined;
	/** Signs in to `running` as its owner, runs `steps`, then stops it (its worker's last upload runs then). */
	const as = async (
		running: P2Server,
		steps: (owner: Host, statuses: (until: (value: Status) => boolean) => Promise<Status>) => Promise<void>,
	) => {
		const owner = clientHost(await localOwner(running));
		const backup = await running.host.get(Backup, {}, BACKGROUND_CONTEXT);
		try {
			await steps(owner, (predicate) => until(backup.statuses, predicate, 20_000));
		} finally {
			backup.release();
			await owner.close(BACKGROUND_CONTEXT);
			await running.close();
		}
	};
	const send = async (owner: Host, session: string, text: string) => {
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		try {
			await chat.send({ text, requestId: crypto.randomUUID() }, BACKGROUND_CONTEXT);
			await until(chat.view, answered);
		} finally {
			chat.release();
		}
	};
	const restart = () => startServer({ dataDir: directory, port: 0, fake: true, web: false });

	// Person A (the fixture's principal) backs a session up.
	let session = "";
	let name = "";
	let head = 0;
	await as(server, async (owner, statuses) => {
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		session = (await sessions.create({ cwd: directory, title: "Shared machine" }, BACKGROUND_CONTEXT)).id;
		sessions.release();
		name = `session-${session}`;
		await send(owner, session, "person A");
		head = (await statuses((value) => value?.[name]?.state === "synced"))?.[name]?.syncedHead ?? 0;
	});
	const accountFile = join(directory, "sessions", session, "backup", "radius", `${name}.account`);
	assert.equal(readFileSync(accountFile, "utf8"), `${radius.actor.organization_id}/${radius.actor.id}`);
	const slots = () => radius.sync.stores.get(name)?.slots.length;
	const uploaded = slots();

	// Person B signs in on the machine and continues the session: nothing goes to B's backup.
	radius.actor.id = "usr_2";
	await as(await restart(), async (owner, statuses) => {
		await send(owner, session, "person B");
		await statuses((value) => {
			const status = value?.[name];
			return status?.state === "paused" && status.reason === "other_account";
		});
	});
	assert.equal(slots(), uploaded, "nothing uploaded as person B");

	// Person A again: the commits waited in the outbox and go on from where A's backup ended, as a batch.
	radius.actor.id = "usr_1";
	await as(await restart(), async (owner, statuses) => {
		await send(owner, session, "person A again");
		await statuses((value) => value?.[name]?.state === "synced" && (value[name]?.syncedHead ?? 0) > head);
	});
	const next = radius.sync.stores.get(name)?.slots.find((slot) => slot.after === head);
	assert.ok(next !== undefined && next.archive === undefined, "a batch after A's last slot, not a full copy");
});
