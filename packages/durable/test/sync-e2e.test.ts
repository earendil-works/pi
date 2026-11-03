// Two devices continue one session through a remote folder: SQLite files holding a Chord store with its outbox,
// Durable's storage on it, real Harnesses, the faux model. The hosts' side as p2 will run it: a Harness only on a
// device's own file, upload and pull through the store while no Harness holds it.
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "@earendil-works/chord";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { StoreStorage } from "../src/storage/store/index.ts";
import { FileSyncStateStore, FileSystemSyncRemote, pullSession, readOutbox, uploadSession } from "../src/sync/index.ts";
import type { Seq, Storage } from "../src/types.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, textOf, unanswered } from "./chat-support.ts";
import { context } from "./session-support.ts";
import { backend, SESSION_OWNER } from "./sync-support.ts";

const SESSION = "s1";
const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temp(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

/** Durable's storage on a store that the storage's close closes too: the Harness owns the store while it runs. */
async function harnessStorage(store: Store): Promise<Storage> {
	const storage = await StoreStorage.open(store, SESSION_OWNER, context);
	const close = storage.close.bind(storage);
	return Object.assign(storage, {
		close: async (ctx: typeof context) => {
			await close(ctx);
			await store.close(ctx);
		},
	});
}

/** One device: its data directory, its sync state and its faux model. */
async function device(name: string, remote: FileSystemSyncRemote) {
	const dir = await temp(`pi-durable-e2e-${name}-`);
	const state = new FileSyncStateStore(new NodeExecutionEnv({ cwd: dir }), join(dir, "sync"));
	const setup: ChatSetup = chatSetup();
	const file = (sessionId: string) => join(dir, `${sessionId}.sqlite`);
	const exists = async (sessionId: string) =>
		(await import("node:fs/promises")).access(file(sessionId)).then(
			() => true,
			() => false,
		);
	/** Runs `fn` on the session's store with its outbox, as the host's uploader does when no worker runs it. */
	const withStore = async <T>(sessionId: string, fn: (store: Store) => Promise<T>): Promise<T> => {
		const store = await openStore(await backend(file(sessionId)), context, { outbox: true });
		try {
			return await fn(store);
		} finally {
			await store.close(context);
		}
	};
	return {
		name,
		setup,
		state,
		open: async (sessionId = SESSION) =>
			openChat(
				await harnessStorage(await openStore(await backend(file(sessionId)), context, { outbox: true })),
				setup,
			),
		/** Renames a stopped copy. The new ID has no remote history, so no sync state either. */
		rename: async (from: string, to: string) => {
			for (const suffix of ["", "-wal", "-shm"])
				await rename(file(from) + suffix, file(to) + suffix).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
			await state.delete(from, context);
		},
		/** Removes a stopped copy so the next pull restores it fresh. */
		forget: async (sessionId = SESSION) => {
			for (const suffix of ["", "-wal", "-shm"]) await rm(file(sessionId) + suffix, { force: true });
			await state.delete(sessionId, context);
		},
		outbox: (after: Seq, sessionId = SESSION) =>
			withStore(sessionId, (store) => readOutbox(store, after, 1000, context)),
		head: (sessionId = SESSION): Promise<number> => withStore(sessionId, async (store) => store.lastSeq),
		upload: (sessionId = SESSION) =>
			withStore(sessionId, (source) =>
				uploadSession({ sessionId, device: name, source, store: remote, state, context }),
			),
		pull: async (sessionId = SESSION) => {
			const local = (await exists(sessionId))
				? ({
						kind: "store",
						store: await openStore(await backend(file(sessionId)), context, { outbox: true }),
					} as const)
				: ({ kind: "empty", backend: await backend(file(sessionId)) } as const);
			const result = await pullSession({ sessionId, store: remote, local, state, context });
			await result.store.close(context);
			return result.head;
		},
	};
}

async function setupDevices() {
	const root = await temp("pi-durable-e2e-remote-");
	const remote = new FileSystemSyncRemote(new NodeExecutionEnv({ cwd: root }), root);
	return { remote, laptop: await device("laptop", remote), desktop: await device("desktop", remote) };
}

type Device = Awaited<ReturnType<typeof device>>;

/** One answered turn on `on`'s copy; the Harness is closed afterwards, as a stopped worker. */
async function turn(on: Device, input: string, answer: string): Promise<void> {
	on.setup.faux.setResponses([fauxAssistantMessage(answer)]);
	const { harness, root } = await on.open();
	const settled = await (await root.submit({ type: "input", content: input }, context)).wait(context);
	expect(settled.status).toBe("done");
	await harness.waitForIdle(context);
	await harness.close(context);
}

/** The conversation's messages on `on`'s copy, opened without scheduling (a viewer). */
async function transcript(on: Device, sessionId = SESSION): Promise<string[]> {
	const { harness, root } = await on.open(sessionId);
	try {
		return (await allEntries(root))
			.flatMap((entry) => entry.model ?? [])
			.map((message) => `${message.role}:${textOf(message)}`);
	} finally {
		await harness.close(context);
	}
}

describe("session sync end to end", () => {
	it("continues a session on another device and back", async () => {
		const { laptop, desktop } = await setupDevices();

		await turn(laptop, "hi", "one");
		expect((await laptop.upload()).type).toBe("uploaded");

		await desktop.pull();
		expect(await desktop.head()).toBe(await laptop.head());
		expect(await transcript(desktop)).toEqual(["user:hi", "assistant:one"]);

		await turn(desktop, "again", "two");
		expect((await desktop.upload()).type).toBe("uploaded");

		await laptop.pull();
		expect(await laptop.head()).toBe(await desktop.head());
		await turn(laptop, "third", "three");
		expect((await laptop.upload()).type).toBe("uploaded");

		await desktop.pull();
		expect(await transcript(desktop)).toEqual([
			"user:hi",
			"assistant:one",
			"user:again",
			"assistant:two",
			"user:third",
			"assistant:three",
		]);
	});

	it("does not write when a viewer opens a pulled copy", async () => {
		const { laptop, desktop } = await setupDevices();
		await turn(laptop, "hi", "one");
		await laptop.upload();
		await desktop.pull();
		const before = await desktop.head();
		await transcript(desktop);
		expect(await desktop.head()).toBe(before);
		expect((await desktop.upload()).type).toBe("idle");
	});

	// Recovery on open resets the origin's running generation to pending: a viewer that opens the Harness writes, and
	// whichever device uploads first keeps the session. Hosts must not open a Harness on a copy they only show.
	it("writes when a copy with work in flight opens, which forks the origin", async () => {
		const { laptop, desktop } = await setupDevices();
		const busy = unanswered();
		laptop.setup.faux.setResponses([busy.step]);
		const { harness, root } = await laptop.open();
		await root.submit({ type: "input", content: "slow" }, context);
		await busy.reached;
		// The laptop uploads while its generation is still running, through its own handle.
		expect((await laptop.upload()).type).toBe("uploaded");

		await desktop.pull();
		const before = await desktop.head();
		const viewer = await desktop.open();
		expect((await allEntries(viewer.root)).map((entry) => entry.kind)).toEqual(["pi.user"]);
		await viewer.harness.close(context);
		// Opening the Harness wrote one commit: recovery resets the running generation to pending.
		const written = await desktop.outbox(before as Seq);
		expect(written).toHaveLength(1);
		expect(JSON.stringify(written[0]!.writes)).toContain('"restarts":1');

		expect((await desktop.upload()).type).toBe("uploaded");
		await root.abort(context);
		await harness.waitForIdle(context);
		await harness.close(context);
		expect(await laptop.upload()).toEqual({ type: "diverged", at: before });
	});

	it("forks the copy that loses the race to a new session", async () => {
		const { laptop, desktop } = await setupDevices();
		await turn(laptop, "hi", "one");
		await laptop.upload();
		await desktop.pull();
		const shared = await laptop.head();

		await turn(laptop, "laptop", "from laptop");
		await turn(desktop, "desktop", "from desktop");
		expect((await laptop.upload()).type).toBe("uploaded");
		const result = await desktop.upload();
		expect(result).toEqual({ type: "diverged", at: shared });

		// The desktop renames its copy, uploads all of it under the new ID, and restores the session from the remote.
		await desktop.rename(SESSION, "s1-fork");
		expect((await desktop.upload("s1-fork")).type).toBe("uploaded");
		await desktop.forget();
		await desktop.pull();

		const laptopTurn = ["user:hi", "assistant:one", "user:laptop", "assistant:from laptop"];
		const desktopTurn = ["user:hi", "assistant:one", "user:desktop", "assistant:from desktop"];
		expect(await transcript(desktop)).toEqual(laptopTurn);
		expect(await transcript(desktop, "s1-fork")).toEqual(desktopTurn);
		await laptop.pull("s1-fork");
		expect(await transcript(laptop, "s1-fork")).toEqual(desktopTurn);
	});
});
