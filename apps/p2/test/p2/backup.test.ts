// Backup of an instance's stores (`P2_BACKUP_DIR`, `plugins/backup`): each store's owner uploads it (the server its own
// store, each session's worker the session's, through the server in chunks), soon after a finished turn; a session's
// backup restores into a store equal to the session's. Without backup, stores keep no outbox.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openStore, type Store, sqliteBackend } from "@earendil-works/chord";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { FileSyncStateStore, pullSession } from "@earendil-works/chord/sync";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Backup } from "../../plugins/backup/contract.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import { openBackupRemote } from "../../src/runtime/backup.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const answers = (count: number) => (view: ConversationView | null | undefined) =>
	(JSON.stringify(view?.entries ?? []).match(/Echo:/g)?.length ?? 0) >= count &&
	!(view?.docs["pi.live"] as LiveState | undefined)?.run;

/** A store's contents without its manifest, comparable across stores. */
async function contents(store: Store): Promise<string> {
	const parts: string[] = [];
	for await (const part of store.export(BACKGROUND_CONTEXT))
		if (part.kind !== "manifest") parts.push(JSON.stringify(part));
	return parts.sort().join("\n");
}

describe("backup to a folder (fake provider)", () => {
	let root: string;
	let backupDir: string;
	let fixture: Fixture;
	let previous: string | undefined;

	before(async () => {
		root = mkdtempSync(join(tmpdir(), "p2-backup-"));
		backupDir = join(root, "backup");
		previous = process.env.P2_BACKUP_DIR;
		// Read where stores open and by the server's backup; workers inherit it.
		process.env.P2_BACKUP_DIR = backupDir;
		fixture = await startFixture();
	});
	after(async () => {
		// The test stopped the server already; closing again only removes the fixture's directory.
		await fixture?.close().catch(() => {});
		if (previous === undefined) delete process.env.P2_BACKUP_DIR;
		else process.env.P2_BACKUP_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	});

	const send = async (session: Session, text: string, count: number) => {
		const chat = await holdIn(fixture.browser(), Chat, { session: session.id, conversation: 1 }, "participant");
		try {
			await chat.send({ text, requestId: crypto.randomUUID() }, BACKGROUND_CONTEXT);
			await until(chat.view, answers(count));
		} finally {
			chat.release();
		}
	};

	it("uploads the server's store and a session's, a finished turn within a second, and restores the session", async () => {
		const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		const session = await sessions.create({ cwd: fixture.workspace, title: "Backed up" }, BACKGROUND_CONTEXT);
		const name = `session-${session.id}`;
		const backup = await fixture.server.host.get(Backup, {}, BACKGROUND_CONTEXT);
		try {
			assert.equal(typeof backup.device.value, "string", "backup is on");
			await send(session, "first", 1);
			const first = await until(
				backup.statuses,
				(value) =>
					value?.[name]?.state === "synced" &&
					(value[name]?.syncedHead ?? 0) > 0 &&
					value.server?.state === "synced" &&
					(value.server?.syncedHead ?? 0) > 0,
				20_000,
			);
			const head = first?.[name]?.syncedHead ?? 0;

			// A finished turn is urgent: in the backup well before the ordinary 5 s.
			const sent = performance.now();
			await send(session, "second", 2);
			await until(
				backup.statuses,
				(value) => value?.[name]?.state === "synced" && (value[name]?.syncedHead ?? 0) > head,
				20_000,
			);
			assert.ok(
				performance.now() - sent < 2000,
				`uploaded ${Math.round(performance.now() - sent)} ms after the send`,
			);
			assert.ok(readdirSync(join(backupDir, name, "slots")).length >= 2, "a first upload and a later batch");
			assert.ok(existsSync(join(backupDir, "server", "slots")));

			// A change of the server's store (a rename): the store tells of the commit, an ordinary upload follows (5 s).
			const serverHead = (await until(backup.statuses, (value) => value?.server?.state === "synced"))?.server
				?.syncedHead;
			await sessions.rename({ id: session.id, title: "Renamed" }, BACKGROUND_CONTEXT);
			await until(
				backup.statuses,
				(value) => value?.server?.state === "synced" && (value.server?.syncedHead ?? 0) > (serverHead ?? 0),
				20_000,
			);
		} finally {
			backup.release();
			sessions.release();
		}

		// The server stops, and the worker with it (its last upload runs then); the data stays until `after`. The session's
		// backup restores into a store equal to the session's.
		await fixture.server.close();
		const { remote, files } = openBackupRemote({ kind: "folder", path: backupDir }, fixture.dataDir);
		const restored = await pullSession({
			sessionId: name,
			store: remote,
			local: { kind: "empty", backend: sqliteBackend(await openNodeSqliteDatabase(join(root, "restored.sqlite"))) },
			state: new FileSyncStateStore(files, join(root, "restore-state")),
			context: BACKGROUND_CONTEXT,
		});
		const original = await openStore(
			sqliteBackend(await openNodeSqliteDatabase(join(fixture.dataDir, "sessions", session.id, "store.sqlite"))),
			BACKGROUND_CONTEXT,
		);
		try {
			assert.equal(restored.head, original.lastSeq, "everything committed is in the backup");
			assert.equal(await contents(restored.store), await contents(original));
		} finally {
			await restored.store.close(BACKGROUND_CONTEXT);
			await original.close(BACKGROUND_CONTEXT);
		}
	});
});

describe("without backup", () => {
	it("keeps no outbox in the stores", async () => {
		const previous = process.env.P2_BACKUP_DIR;
		delete process.env.P2_BACKUP_DIR;
		const fixture = await startFixture();
		try {
			const backup = await fixture.server.host.get(Backup, {}, BACKGROUND_CONTEXT);
			assert.equal(backup.device.value, null);
			backup.release();
		} finally {
			await fixture.close();
			if (previous !== undefined) process.env.P2_BACKUP_DIR = previous;
		}
		const store = await openStore(
			sqliteBackend(await openNodeSqliteDatabase(join(fixture.dataDir, "server", "store.sqlite"))),
			BACKGROUND_CONTEXT,
		);
		try {
			assert.equal(store.outbox, undefined);
		} finally {
			await store.close(BACKGROUND_CONTEXT);
		}
	});
});
