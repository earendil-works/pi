import { existsSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionBackend, JsonlSessionRepository } from "../../src/harness/session/jsonl-repo.ts";
import { InMemorySessionBackend, InMemorySessionRepository } from "../../src/harness/session/memory-repo.ts";
import { createSession } from "../../src/harness/session/session.ts";
import type { SessionForkSelection, SessionMetadata, SessionStorage } from "../../src/harness/types.ts";
import { createAssistantMessage, createTempDir, createUserMessage } from "./session-test-utils.ts";

afterEach(() => {
	vi.useRealTimers();
});

class CountingReadEnv extends NodeExecutionEnv {
	readCount = 0;

	override async readTextFile(path: string, abortSignal?: AbortSignal) {
		this.readCount += 1;
		return super.readTextFile(path, abortSignal);
	}
}

function createDeferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function settlesBeforeNextTurn(promise: Promise<unknown>): Promise<boolean> {
	return Promise.race([
		promise.then(() => true),
		new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
	]);
}

class PerPathBlockingAppendEnv extends NodeExecutionEnv {
	private readonly appendBlocks = new Map<string, { started: Deferred; release: Deferred }>();
	private listBlock: { started: Deferred; release: Deferred } | undefined;
	readonly appendCounts = new Map<string, number>();

	blockAppend(path: string): { started: Deferred; release: Deferred } {
		const block = { started: createDeferred(), release: createDeferred() };
		this.appendBlocks.set(path, block);
		return block;
	}

	blockNextList(): { started: Deferred; release: Deferred } {
		const block = { started: createDeferred(), release: createDeferred() };
		this.listBlock = block;
		return block;
	}

	override async exists(path: string) {
		if (this.appendBlocks.has(path)) return { ok: true as const, value: true };
		return super.exists(path);
	}

	override async appendFile(path: string, content: string | Uint8Array) {
		this.appendCounts.set(path, (this.appendCounts.get(path) ?? 0) + 1);
		const block = this.appendBlocks.get(path);
		if (block) {
			block.started.resolve();
			await block.release.promise;
		}
		return super.appendFile(path, content);
	}

	override async listDir(path: string) {
		const block = this.listBlock;
		if (block) {
			this.listBlock = undefined;
			block.started.resolve();
			await block.release.promise;
		}
		return super.listDir(path);
	}
}

function createEntry(id: string) {
	return {
		type: "message" as const,
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: createUserMessage(id),
	};
}

class BlockingCreateEnv extends NodeExecutionEnv {
	readonly firstWriteStarted = createDeferred();
	readonly secondWriteStarted = createDeferred();
	readonly releaseFirstWrite = createDeferred();
	readonly writtenPaths = new Set<string>();
	readonly writePaths: string[] = [];

	override async createDir() {
		return { ok: true as const, value: undefined };
	}

	override async exists(path: string) {
		return { ok: true as const, value: this.writtenPaths.has(path) };
	}

	override async writeFile(path: string) {
		this.writePaths.push(path);
		if (this.writePaths.length === 1) {
			this.firstWriteStarted.resolve();
			await this.releaseFirstWrite.promise;
		}
		if (this.writePaths.length === 2) this.secondWriteStarted.resolve();
		this.writtenPaths.add(path);
		return { ok: true as const, value: undefined };
	}
}

class BlockingAppendEnv extends NodeExecutionEnv {
	readonly appendStarted = createDeferred();
	readonly releaseAppend = createDeferred();

	override async appendFile(path: string, content: string | Uint8Array) {
		this.appendStarted.resolve();
		await this.releaseAppend.promise;
		return super.appendFile(path, content);
	}
}

interface SessionBackendReadCounter {
	openCount: number;
	readHeadCount: number;
	readEntriesCount: number;
	readPathCount: number;
	forkSelections: SessionForkSelection[];
}

function createCountingInMemorySessionBackend(): {
	backend: Pick<InMemorySessionBackend, "create" | "open" | "list" | "delete" | "fork" | typeof Symbol.asyncDispose>;
	counter: SessionBackendReadCounter;
} {
	const source = new InMemorySessionBackend();
	const counter: SessionBackendReadCounter = {
		openCount: 0,
		readHeadCount: 0,
		readEntriesCount: 0,
		readPathCount: 0,
		forkSelections: [],
	};
	const countReads = (storage: SessionStorage<SessionMetadata>): SessionStorage<SessionMetadata> => ({
		metadata: storage.metadata,
		readHead: () => {
			counter.readHeadCount += 1;
			return storage.readHead();
		},
		readEntry: (id) => storage.readEntry(id),
		readEntries: (options) => {
			counter.readEntriesCount += 1;
			return storage.readEntries(options);
		},
		appendEntry: (entry) => storage.appendEntry(entry),
		findEntriesOnBranch: (query) => storage.findEntriesOnBranch(query),
		readPathToRootOrCompaction: (leafId) => {
			counter.readPathCount += 1;
			return storage.readPathToRootOrCompaction(leafId);
		},
		getLabel: (id) => storage.getLabel(id),
		getName: () => storage.getName(),
		getStats: () => storage.getStats(),
	});
	return {
		counter,
		backend: {
			create: (options) => source.create(options),
			async open(metadata) {
				counter.openCount += 1;
				return countReads(await source.open(metadata));
			},
			list: () => source.list(),
			delete: (metadata) => source.delete(metadata),
			fork: (metadata, options, selection) => {
				counter.forkSelections.push(selection);
				return source.fork(metadata, options, selection);
			},
			[Symbol.asyncDispose]: () => source[Symbol.asyncDispose](),
		},
	};
}

describe("InMemorySessionBackend", () => {
	it("opens, deletes, and forks by metadata", async () => {
		const repo = new InMemorySessionRepository();
		const session = await repo.create({ id: "session-1" });
		const metadata = await session.getMetadata();
		const user1 = await session.appendMessage(createUserMessage("one"));
		const assistant1 = await session.appendMessage(createAssistantMessage("two"));
		const user2 = await session.appendMessage(createUserMessage("three"));
		await expect((await repo.open(metadata)).getMetadata()).resolves.toEqual(metadata);
		expect((await repo.list()).map((info) => info.id)).toEqual(["session-1"]);
		const fork = await repo.fork(metadata, { entryId: user2, id: "session-2" });
		expect((await fork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		const fullFork = await repo.fork(metadata, { id: "session-3" });
		const throughFork = await repo.fork(metadata, {
			entryId: assistant1,
			position: "at",
			id: "session-4",
		});
		expect((await throughFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		await expect(repo.fork(metadata, { entryId: assistant1, id: "session-5" })).rejects.toMatchObject({
			code: "invalid_fork_target",
		});
		await expect(repo.fork(metadata, { entryId: "missing", id: "session-6" })).rejects.toMatchObject({
			code: "invalid_fork_target",
		});
		expect((await fullFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1, user2]);
		await repo.delete(metadata);
		await expect(repo.open(metadata)).rejects.toThrow("Session not found: session-1");
	});

	it("delegates full-session fork selection without opening the source", async () => {
		const { backend, counter } = createCountingInMemorySessionBackend();
		const source = await createSession(await backend.create({ id: "session-1" }));
		await source.appendMessage(createUserMessage("one"));

		const fork = await createSession(
			await backend.fork(await source.getMetadata(), { id: "session-2" }, { kind: "all" }),
		);

		expect((await fork.getEntries()).map((entry) => entry.id)).toHaveLength(1);
		expect(counter).toMatchObject({
			openCount: 0,
			readHeadCount: 0,
			readEntriesCount: 0,
			readPathCount: 0,
			forkSelections: [{ kind: "all" }],
		});
	});

	it("retains the opened aggregate instead of reloading for scoped reads", async () => {
		const { backend, counter } = createCountingInMemorySessionBackend();
		const session = await createSession(await backend.create({ id: "session-1" }));
		const entryId = await session.appendMessage(createUserMessage("one"));

		await session.getMetadata();
		await session.getLeafId();
		await session.getEntry(entryId);
		expect(counter.openCount).toBe(0);
	});

	it("builds context from the branch storage without loading complete history", async () => {
		const { backend, counter } = createCountingInMemorySessionBackend();
		const created = await createSession(await backend.create({ id: "session-1" }));
		await created.appendMessage(createUserMessage("one"));
		const opened = await createSession(await backend.open(await created.getMetadata()));

		await opened.buildContext();

		expect(counter).toMatchObject({ openCount: 1, readHeadCount: 1, readEntriesCount: 0, readPathCount: 1 });
	});

	it("rejects repository operations and session writes after disposal", async () => {
		const repo = new InMemorySessionRepository();
		const session = await repo.create({ id: "session-1" });
		await repo[Symbol.asyncDispose]();

		await expect(repo.list()).rejects.toThrow("In-memory session repository is disposed");
		await expect(session.appendMessage(createUserMessage("late"))).rejects.toThrow(
			"In-memory session repository is disposed",
		);
	});

	it("supports lexical ownership with await using", async () => {
		let listDisposedRepository: (() => Promise<SessionMetadata[]>) | undefined;
		{
			await using repository = new InMemorySessionRepository();
			listDisposedRepository = () => repository.list();
			await repository.create({ id: "session-1" });
		}

		await expect(listDisposedRepository!()).rejects.toThrow("In-memory session repository is disposed");
	});
});

describe("JsonlSessionBackend", () => {
	it.each(["create", "fork"] as const)(
		"serializes conflicting create and %s destinations",
		async (secondOperation) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const root = createTempDir();
			const env = new BlockingCreateEnv({ cwd: root });
			const sourcePath = `${root}/source.jsonl`;
			writeFileSync(
				sourcePath,
				`${JSON.stringify({ type: "session", version: 3, id: "source", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/tmp/source" })}\n`,
			);
			env.writtenPaths.add(sourcePath);
			const backend = new JsonlSessionBackend({ fs: env, sessionsRoot: root });
			const options = { cwd: "/tmp/target", id: "shared-id" };
			const first = backend.create(options);
			await env.firstWriteStarted.promise;
			const second =
				secondOperation === "create"
					? backend.create(options)
					: backend.fork(
							{
								id: "source",
								createdAt: "2025-01-01T00:00:00.000Z",
								cwd: "/tmp/source",
								path: sourcePath,
							},
							options,
							{ kind: "all" },
						);
			const secondStartedBeforeFirstFinished = await settlesBeforeNextTurn(env.secondWriteStarted.promise);

			env.releaseFirstWrite.resolve();
			const results = await Promise.allSettled([first, second]);

			expect(secondStartedBeforeFirstFinished).toBe(false);
			expect(env.writePaths).toHaveLength(1);
			expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
			expect(results[1]).toMatchObject({
				status: "rejected",
				reason: { code: "invalid_session", message: expect.stringContaining("Session already exists") },
			});
		},
	);

	it("encodes custom session IDs used in filenames", async () => {
		const root = createTempDir();
		const backend = new JsonlSessionBackend({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
		const snapshot = await backend.create({ cwd: root, id: "../unsafe\\id" });

		expect(snapshot.metadata.path).toContain("..%2Funsafe%5Cid.jsonl");
		expect(existsSync(snapshot.metadata.path)).toBe(true);
	});

	it("allows appends to different sessions to run concurrently", async () => {
		const root = createTempDir();
		const env = new PerPathBlockingAppendEnv({ cwd: root });
		const backend = new JsonlSessionBackend({ fs: env, sessionsRoot: root });
		const first = await backend.create({ cwd: "/tmp/first", id: "first" });
		const second = await backend.create({ cwd: "/tmp/second", id: "second" });
		const firstBlock = env.blockAppend(first.metadata.path);
		const secondBlock = env.blockAppend(second.metadata.path);

		const firstAppend = first.appendEntry(createEntry("first-entry"));
		await firstBlock.started.promise;
		const secondAppend = second.appendEntry(createEntry("second-entry"));
		const secondStartedBeforeFirstFinished = await settlesBeforeNextTurn(secondBlock.started.promise);

		firstBlock.release.resolve();
		secondBlock.release.resolve();
		await Promise.all([firstAppend, secondAppend]);
		expect(secondStartedBeforeFirstFinished).toBe(true);
	});

	it("caps concurrent operations across JSONL sessions at four by default", async () => {
		const root = createTempDir();
		const env = new PerPathBlockingAppendEnv({ cwd: root });
		const backend = new JsonlSessionBackend({ fs: env, sessionsRoot: root });
		const snapshots = [];
		for (let index = 0; index < 6; index++) {
			snapshots.push(await backend.create({ cwd: `/tmp/session-${index}`, id: `session-${index}` }));
		}
		const blocks = snapshots.map((snapshot) => env.blockAppend(snapshot.metadata.path));
		const appends = snapshots.map((snapshot, index) => snapshot.appendEntry(createEntry(`entry-${index}`)));
		await Promise.all(blocks.slice(0, 4).map((block) => block.started.promise));
		const fifthStartedWithoutCapacity = await settlesBeforeNextTurn(blocks[4]!.started.promise);
		const sixthStartedWithoutCapacity = await settlesBeforeNextTurn(blocks[5]!.started.promise);

		for (const block of blocks) block.release.resolve();
		await Promise.all(appends);

		expect(fifthStartedWithoutCapacity).toBe(false);
		expect(sixthStartedWithoutCapacity).toBe(false);
	});

	it("allows overriding the JSONL concurrency limit", async () => {
		const root = createTempDir();
		const env = new PerPathBlockingAppendEnv({ cwd: root });
		const backend = new JsonlSessionBackend({ fs: env, sessionsRoot: root, maxConcurrentOperations: 1 });
		const first = await backend.create({ cwd: "/tmp/first", id: "first" });
		const second = await backend.create({ cwd: "/tmp/second", id: "second" });
		const firstBlock = env.blockAppend(first.metadata.path);
		const secondBlock = env.blockAppend(second.metadata.path);
		const firstAppend = first.appendEntry(createEntry("first-entry"));
		await firstBlock.started.promise;
		const secondAppend = second.appendEntry(createEntry("second-entry"));
		const secondStartedBeforeFirstFinished = await settlesBeforeNextTurn(secondBlock.started.promise);

		firstBlock.release.resolve();
		secondBlock.release.resolve();
		await Promise.all([firstAppend, secondAppend]);
		expect(secondStartedBeforeFirstFinished).toBe(false);
	});

	it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
		"rejects invalid JSONL concurrency limit %s",
		(maxConcurrentOperations) => {
			const root = createTempDir();
			expect(
				() =>
					new JsonlSessionBackend({
						fs: new NodeExecutionEnv({ cwd: root }),
						sessionsRoot: root,
						maxConcurrentOperations,
					}),
			).toThrow("maxConcurrentOperations must be a positive integer");
		},
	);

	it("releases JSONL concurrency capacity after an operation fails", async () => {
		const root = createTempDir();
		const backend = new JsonlSessionBackend({
			fs: new NodeExecutionEnv({ cwd: root }),
			sessionsRoot: root,
			maxConcurrentOperations: 1,
		});
		const first = await backend.create({ cwd: "/tmp/first", id: "first" });
		const second = await backend.create({ cwd: "/tmp/second", id: "second" });
		const duplicate = createEntry("duplicate-entry");
		await first.appendEntry(duplicate);

		const failure = first.appendEntry(duplicate);
		const nextSession = second.appendEntry(createEntry("next-entry"));

		await expect(failure).rejects.toThrow("Entry duplicate-entry already exists");
		await expect(nextSession).resolves.toBeUndefined();
	});

	it("serializes appends to the same session", async () => {
		const root = createTempDir();
		const env = new PerPathBlockingAppendEnv({ cwd: root });
		const backend = new JsonlSessionBackend({ fs: env, sessionsRoot: root });
		const snapshot = await backend.create({ cwd: root, id: "session" });
		const block = env.blockAppend(snapshot.metadata.path);

		const firstAppend = snapshot.appendEntry(createEntry("first-entry"));
		await block.started.promise;
		const secondAppend = snapshot.appendEntry(createEntry("second-entry"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		const appendCountWhileFirstWasBlocked = env.appendCounts.get(snapshot.metadata.path);

		block.release.resolve();
		await Promise.all([firstAppend, secondAppend]);
		expect(appendCountWhileFirstWasBlocked).toBe(1);
		expect((await (await backend.open(snapshot.metadata)).readEntries()).map((entry) => entry.id)).toEqual([
			"first-entry",
			"second-entry",
		]);
	});

	it("uses listing as a barrier between accepted session operations", async () => {
		const root = createTempDir();
		const env = new PerPathBlockingAppendEnv({ cwd: root });
		const backend = new JsonlSessionBackend({ fs: env, sessionsRoot: root });
		const first = await backend.create({ cwd: "/tmp/first", id: "first" });
		const second = await backend.create({ cwd: "/tmp/second", id: "second" });
		const firstBlock = env.blockAppend(first.metadata.path);
		const secondBlock = env.blockAppend(second.metadata.path);
		const listBlock = env.blockNextList();

		const firstAppend = first.appendEntry(createEntry("first-entry"));
		await firstBlock.started.promise;
		const list = backend.list();
		const secondAppend = second.appendEntry(createEntry("second-entry"));
		const listStartedBeforeFirstFinished = await settlesBeforeNextTurn(listBlock.started.promise);

		firstBlock.release.resolve();
		await firstAppend;
		await listBlock.started.promise;
		const secondStartedBeforeListFinished = await settlesBeforeNextTurn(secondBlock.started.promise);
		listBlock.release.resolve();
		await list;
		await secondBlock.started.promise;
		secondBlock.release.resolve();
		await secondAppend;

		expect(listStartedBeforeFirstFinished).toBe(false);
		expect(secondStartedBeforeListFinished).toBe(false);
	});

	it("waits for every accepted session operation during disposal", async () => {
		const root = createTempDir();
		const env = new PerPathBlockingAppendEnv({ cwd: root });
		const backend = new JsonlSessionBackend({ fs: env, sessionsRoot: root });
		const first = await backend.create({ cwd: "/tmp/first", id: "first" });
		const second = await backend.create({ cwd: "/tmp/second", id: "second" });
		const firstBlock = env.blockAppend(first.metadata.path);
		const secondBlock = env.blockAppend(second.metadata.path);
		const firstAppend = first.appendEntry(createEntry("first-entry"));
		const secondAppend = second.appendEntry(createEntry("second-entry"));
		await Promise.all([firstBlock.started.promise, secondBlock.started.promise]);

		let disposed = false;
		const dispose = backend[Symbol.asyncDispose]().then(() => {
			disposed = true;
		});
		firstBlock.release.resolve();
		await firstAppend;
		await new Promise<void>((resolve) => setImmediate(resolve));
		const disposedWhileSecondWasBlocked = disposed;
		secondBlock.release.resolve();
		await Promise.all([secondAppend, dispose]);

		expect(disposedWhileSecondWasBlocked).toBe(false);
		expect(disposed).toBe(true);
	});

	it("waits for accepted appends before disposal and rejects later writes", async () => {
		const root = createTempDir();
		const env = new BlockingAppendEnv({ cwd: root });
		const repo = new JsonlSessionRepository({ fs: env, sessionsRoot: root });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const append = session.appendMessage(createUserMessage("accepted"));
		await env.appendStarted.promise;
		let closed = false;
		const dispose = repo[Symbol.asyncDispose]().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		env.releaseAppend.resolve();
		await append;
		await dispose;
		await expect(session.appendMessage(createUserMessage("late"))).rejects.toThrow(
			"JSONL session repository is disposed",
		);
	});

	it("parses once when opened and retains state across appends", async () => {
		const root = createTempDir();
		const env = new CountingReadEnv({ cwd: root });
		const repo = new JsonlSessionRepository({ fs: env, sessionsRoot: root });
		const created = await repo.create({ cwd: root, id: "session-1" });
		const metadata = await created.getMetadata();
		await created.appendMessage(createUserMessage("initial"));
		env.readCount = 0;
		const opened = await repo.open(metadata);
		for (let i = 0; i < 10; i++) await opened.appendMessage(createUserMessage(`message ${i}`));
		expect(env.readCount).toBe(1);
	});

	it("collects sessions below encoded cwd directories and lists by cwd", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const cwd = "/tmp/my-project";
		const otherCwd = "/tmp/other-project";
		const repo = new JsonlSessionRepository({ fs: env, sessionsRoot: root });
		const session = await repo.create({ cwd, id: "019de8c2-de29-73e9-ae0c-e134db34c447" });
		const otherSession = await repo.create({ cwd: otherCwd, id: "other-session" });
		const metadata = await session.getMetadata();
		const otherMetadata = await otherSession.getMetadata();
		expect(metadata.path).toContain("--tmp-my-project--");
		expect(otherMetadata.path).toContain("--tmp-other-project--");
		expect(existsSync(metadata.path)).toBe(true);
		expect((await repo.list({ cwd })).map((sessionMetadata) => sessionMetadata.id)).toEqual([metadata.id]);
		expect((await repo.list()).map((sessionMetadata) => sessionMetadata.id).sort()).toEqual(
			[metadata.id, otherMetadata.id].sort(),
		);
	});

	it("fails loudly when listing a malformed session file", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepository({ fs: env, sessionsRoot: root });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const metadata = await session.getMetadata();
		writeFileSync(metadata.path, "not json\n");

		await expect(repo.list()).rejects.toMatchObject({ code: "invalid_session" });
	});

	it("rejects a missing active leaf when opened", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const backend = new JsonlSessionBackend({ fs: env, sessionsRoot: root });
		const repo = new JsonlSessionRepository({ fs: env, sessionsRoot: root });
		const storage = await backend.create({ cwd: root, id: "session-1" });
		await storage.appendEntry({
			type: "leaf",
			id: "leaf",
			parentId: null,
			targetId: "missing",
			timestamp: "2026-01-01T00:00:00.000Z",
		});

		await expect(repo.open(storage.metadata)).rejects.toMatchObject({
			code: "invalid_session",
			message: "Entry missing not found",
		});
	});

	it("opens, deletes, and forks by metadata", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepository({ fs: env, sessionsRoot: root });
		const source = await repo.create({ cwd: "/tmp/source", id: "source-session" });
		const sourceMetadata = await source.getMetadata();
		const user1 = await source.appendMessage(createUserMessage("one"));
		const assistant1 = await source.appendMessage(createAssistantMessage("two"));
		const user2 = await source.appendMessage(createUserMessage("three"));
		await expect((await repo.open(sourceMetadata)).getMetadata()).resolves.toEqual(sourceMetadata);
		const fork = await repo.fork(sourceMetadata, { cwd: "/tmp/target", id: "fork-session", entryId: user2 });
		const forkMetadata = await fork.getMetadata();
		expect(forkMetadata.cwd).toBe("/tmp/target");
		expect(forkMetadata.parentSessionPath).toBe(sourceMetadata.path);
		expect((await fork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		const fullFork = await repo.fork(sourceMetadata, { cwd: "/tmp/target", id: "full-fork-session" });
		expect((await fullFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1, user2]);
		await repo.delete(sourceMetadata);
		expect(existsSync(sourceMetadata.path)).toBe(false);
		await expect(repo.open(sourceMetadata)).rejects.toThrow("Session not found");
	});

	it("persists header metadata through create, list, and fork", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepository({ fs: env, sessionsRoot: root });
		const source = await repo.create({
			cwd: "/tmp/source",
			id: "source-session",
			metadata: { profile: "reviewer" },
		});
		const sourceMetadata = await source.getMetadata();
		expect(sourceMetadata.metadata).toEqual({ profile: "reviewer" });
		expect((await repo.list({ cwd: "/tmp/source" })).map((listed) => listed.metadata)).toEqual([
			{ profile: "reviewer" },
		]);
		const fork = await repo.fork(sourceMetadata, { cwd: "/tmp/target", id: "fork-session" });
		expect((await fork.getMetadata()).metadata).toEqual({ profile: "reviewer" });
		const overridden = await repo.fork(sourceMetadata, {
			cwd: "/tmp/target",
			id: "overridden-session",
			metadata: { profile: "writer" },
		});
		expect((await overridden.getMetadata()).metadata).toEqual({ profile: "writer" });
	});
});
