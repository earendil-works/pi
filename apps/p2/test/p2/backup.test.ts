// Backup of an instance's stores (`P2_BACKUP_DIR`, `plugins/backup`): each store's owner uploads it (the server its own
// store, each session's worker the session's, through the server in chunks), soon after a finished turn; a session's
// backup restores into a store equal to the session's. Without backup, stores keep no outbox.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openStore, type Store, sqliteBackend } from "@earendil-works/chord";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { FileSyncStateStore, pullSession } from "@earendil-works/chord/sync";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Host } from "@p2/app/v1";
import { Backup } from "../../plugins/backup/contract.ts";
import { openFolderRemote } from "../../plugins/backup/target.ts";
import { backupFiles } from "../../plugins/backup/uploader.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import { type P2Server, startServer } from "../../src/hosts/server.ts";
import { clientHost, type Fixture, holdIn, localOwner, startFixture, until } from "./helpers.ts";

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
		const restored = await pullSession({
			sessionId: name,
			store: openFolderRemote(backupDir, fixture.dataDir),
			local: { kind: "empty", backend: sqliteBackend(await openNodeSqliteDatabase(join(root, "restored.sqlite"))) },
			state: new FileSyncStateStore(backupFiles(fixture.dataDir), join(root, "restore-state")),
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

describe("backup across restarts (fake provider)", () => {
	let root: string;
	let dataDir: string;
	let workspace: string;
	let backupDir: string;
	let previous: string | undefined;

	before(() => {
		root = mkdtempSync(join(tmpdir(), "p2-backup-gap-"));
		dataDir = join(root, "data");
		workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		backupDir = join(root, "backup");
		previous = process.env.P2_BACKUP_DIR;
	});
	after(() => {
		if (previous === undefined) delete process.env.P2_BACKUP_DIR;
		else process.env.P2_BACKUP_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	});

	/** Runs `steps` against a server on the test's data directory, with backup on or off; stops it after them. */
	const withServer = async (backup: boolean, steps: (server: P2Server, owner: Host) => Promise<void>) => {
		if (backup) process.env.P2_BACKUP_DIR = backupDir;
		else delete process.env.P2_BACKUP_DIR;
		const server = await startServer({ dataDir, port: 0, fake: true, web: false });
		const owner = clientHost(await localOwner(server));
		try {
			await steps(server, owner);
		} finally {
			await owner.close(BACKGROUND_CONTEXT);
			// The session's worker stops with it: its last upload runs then.
			await server.close();
		}
	};

	const send = async (owner: Host, session: string, text: string, count: number) => {
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		try {
			await chat.send({ text, requestId: crypto.randomUUID() }, BACKGROUND_CONTEXT);
			await until(chat.view, answers(count));
		} finally {
			chat.release();
		}
	};

	/** Waits until the server's and `name`'s backups are synced; resolves with `name`'s synced head. */
	const synced = async (server: P2Server, name: string): Promise<number> => {
		const backup = await server.host.get(Backup, {}, BACKGROUND_CONTEXT);
		try {
			const statuses = await until(
				backup.statuses,
				(value) => value?.[name]?.state === "synced" && value.server?.state === "synced",
				20_000,
			);
			return statuses?.[name]?.syncedHead ?? 0;
		} finally {
			backup.release();
		}
	};

	/** Restores the session's backup (`name`) from the folder and compares it with the stopped session's store. */
	const restoresEqual = async (session: string, name: string) => {
		const restored = await pullSession({
			sessionId: name,
			store: openFolderRemote(backupDir, dataDir),
			local: { kind: "empty", backend: sqliteBackend(await openNodeSqliteDatabase(":memory:")) },
			state: new FileSyncStateStore(backupFiles(dataDir), join(root, `restore-${crypto.randomUUID()}`)),
			context: BACKGROUND_CONTEXT,
		});
		const original = await openStore(
			sqliteBackend(await openNodeSqliteDatabase(join(dataDir, "sessions", session, "store.sqlite"))),
			BACKGROUND_CONTEXT,
		);
		try {
			assert.equal(restored.head, original.lastSeq, `${name} holds everything committed`);
			assert.equal(await contents(restored.store), await contents(original));
		} finally {
			await restored.store.close(BACKGROUND_CONTEXT);
			await original.close(BACKGROUND_CONTEXT);
		}
	};

	it("goes on from a full copy of what was committed while it was off, in the same history", async () => {
		let session = "";
		let name = "";
		let first = 0;
		await withServer(true, async (server, owner) => {
			const sessions = await holdIn(owner, Sessions, {}, "owner");
			session = (await sessions.create({ cwd: workspace, title: "Gap" }, BACKGROUND_CONTEXT)).id;
			sessions.release();
			name = `session-${session}`;
			await send(owner, session, "first", 1);
			first = await synced(server, name);
			assert.ok(first > 0);
		});

		// Off: the stores open without an outbox (its commits dropped), and the session commits a turn the backup misses.
		await withServer(false, async (server, owner) => {
			await send(owner, session, "while off", 2);
			// Backed up before, off now: paused, not nothing; its last backed-up sequence is still known.
			const backup = await server.host.get(Backup, {}, BACKGROUND_CONTEXT);
			try {
				const paused = await until(backup.statuses, (value) => {
					const status = value?.[name];
					return status?.state === "paused" && status.reason === "off" && (status.syncedHead ?? 0) >= first;
				});
				assert.equal(paused?.server?.state, "paused", "the server's store too");
			} finally {
				backup.release();
			}
		});

		// On again: the outbox starts at the store's head, past what the backup holds, so the next slot is a full copy
		// after it (before, uploads failed here and were retried forever).
		await withServer(true, async (server, owner) => {
			await send(owner, session, "back on", 3);
			assert.ok((await synced(server, name)) > first);
		});
		const slot = (after: number) =>
			JSON.parse(readFileSync(join(backupDir, name, "slots", `${String(after).padStart(16, "0")}.json`), "utf8"));
		assert.equal(slot(first).archive, true, "a full copy right after what the backup held");
		assert.deepEqual(readdirSync(backupDir).sort(), ["server", name].sort(), "no other history");
		await restoresEqual(session, name);

		// A later start goes on with batches after it.
		await withServer(true, async (server, owner) => {
			await send(owner, session, "again", 4);
			await synced(server, name);
		});
		await restoresEqual(session, name);
	});

	/** A new session with one turn backed up; resolves with its ID, its remote name and the backup's head. */
	const backedUp = async (title: string) => {
		let session = "";
		let head = 0;
		await withServer(true, async (server, owner) => {
			const sessions = await holdIn(owner, Sessions, {}, "owner");
			session = (await sessions.create({ cwd: workspace, title }, BACKGROUND_CONTEXT)).id;
			sessions.release();
			await send(owner, session, "first", 1);
			head = await synced(server, `session-${session}`);
		});
		return { session, name: `session-${session}`, head };
	};

	const slotFile = (name: string, after: number) =>
		join(backupDir, name, "slots", `${String(after).padStart(16, "0")}.json`);

	it("starts over with a full copy when the backup was deleted while the server was off", async () => {
		const { session, name, head } = await backedUp("Deleted backup");
		// Deleted on the remote while this server was off: its bookmark still says `head`.
		rmSync(join(backupDir, name), { recursive: true, force: true });
		await withServer(true, async (server, owner) => {
			await send(owner, session, "after the delete", 2);
			assert.ok((await synced(server, name)) > head);
		});
		assert.equal(JSON.parse(readFileSync(slotFile(name, 0), "utf8")).archive, true, "a full copy from the start");
		await restoresEqual(session, name);
	});

	it("stops uploading a store whose backup's history is another's, until a restart", async () => {
		const { session, name, head } = await backedUp("Broken history");
		// Another machine took the slot after this store's head (a copied data directory, say).
		mkdirSync(join(backupDir, name, "batches"), { recursive: true });
		writeFileSync(join(backupDir, name, "batches", `${String(head).padStart(16, "0")}.batch`), "");
		writeFileSync(slotFile(name, head), JSON.stringify({ after: head, to: head + 5, device: "another-machine" }));
		await withServer(true, async (server, owner) => {
			const backup = await server.host.get(Backup, {}, BACKGROUND_CONTEXT);
			try {
				await send(owner, session, "after the other machine", 2);
				const stopped = await until(
					backup.statuses,
					(value) => {
						const status = value?.[name];
						return status?.state === "stopped" && status.reason === "diverged";
					},
					20_000,
				);
				// Later commits upload nothing and report nothing.
				const at = stopped?.[name]?.at;
				await send(owner, session, "again", 3);
				await new Promise((resolve) => setTimeout(resolve, 1500));
				assert.equal(backup.statuses.value?.[name]?.at, at);
			} finally {
				backup.release();
			}
		});
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
