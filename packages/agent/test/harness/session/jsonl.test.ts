import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../../../src/harness/env/nodejs.ts";
import { type JsonlSessionMetadata, JsonlSessionRepo, type SessionRepo } from "../../../src/harness/session/index.ts";
import {
	createSessionBackendConformance,
	type SessionBackendFixture,
} from "../../../src/harness/session/testing/index.ts";
import { FileError } from "../../../src/harness/types.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-agent-jsonl-v4-"));
	tempDirs.push(directory);
	return directory;
}

function createRepository(root: string): JsonlSessionRepo {
	return new JsonlSessionRepo({
		fs: new NodeExecutionEnv({ cwd: root }),
		sessionsRoot: root,
	});
}

function withDefaultSessionCwd(repository: SessionRepo, cwd: string): SessionRepo {
	return {
		create(options) {
			const optionsWithCwd = { ...options, cwd };
			return repository.create(optionsWithCwd);
		},
		open: (metadata) => repository.open(metadata),
		list: () => repository.list(),
		delete: (metadata) => repository.delete(metadata),
		fork(source, options) {
			const optionsWithCwd = { ...options, cwd };
			return repository.fork(source, optionsWithCwd);
		},
	};
}

function expectedSessionPath(root: string, cwd: string, createdAt: number, id: string): string {
	const directory = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
	return join(root, directory, `${timestamp}_${id}.jsonl`);
}

function writeRawSession(root: string, id: string, mutations: Record<string, unknown>[]): JsonlSessionMetadata {
	const path = join(root, `${id}.jsonl`);
	const createdAt = 1;
	const header = { kind: "header", version: 4, id, createdAt, cwd: root };
	writeFileSync(path, `${[header, ...mutations].map((line) => JSON.stringify(line)).join("\n")}\n`);
	return {
		id,
		createdAt,
		cwd: root,
		path,
		modifiedAt: statSync(path).mtimeMs,
		sourceFormat: 4,
	};
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const conformance = createSessionBackendConformance(async () => {
	const root = createTempDir();
	const repository = withDefaultSessionCwd(createRepository(root), root);
	return {
		repository,
		[Symbol.asyncDispose]: () => Promise.resolve(),
	} satisfies SessionBackendFixture;
});

describe("JsonlSessionRepo conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}
});

describe("JSONL v4 persistence", () => {
	it("exposes the complete metadata contract", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const cwd = join(root, "workspace", "project");
		const session = await repository.create({
			id: "metadata",
			cwd,
			parentSessionId: "parent",
			metadata: { owner: "agent", nested: { enabled: true } },
		});
		const metadata = await session.getMetadata();

		expect(metadata).toEqual({
			id: "metadata",
			createdAt: expect.any(Number),
			parentSessionId: "parent",
			path: expectedSessionPath(root, metadata.cwd, metadata.createdAt, metadata.id),
			cwd,
			modifiedAt: statSync(metadata.path).mtimeMs,
			sourceFormat: 4,
			metadata: { owner: "agent", nested: { enabled: true } },
		});
		expect(await repository.list({ cwd })).toEqual([metadata]);
		expect(await repository.list({ cwd: join(root, "other", "project") })).toEqual([]);
	});

	it("rejects session ids that cannot be used in coding-agent filenames", async () => {
		const root = createTempDir();
		const repository = createRepository(root);

		await expect(repository.create({ id: "../escape", cwd: root })).rejects.toMatchObject({
			code: "invalid_payload",
		});
	});

	it("allows the same explicit session id in different working directories", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const firstCwd = join(root, "workspaces", "first");
		const secondCwd = join(root, "workspaces", "second");

		const first = await repository.create({ id: "shared", cwd: firstCwd });
		const second = await repository.create({ id: "shared", cwd: secondCwd });

		expect((await first.getMetadata()).cwd).toBe(firstCwd);
		expect((await second.getMetadata()).cwd).toBe(secondCwd);
		expect((await repository.list()).map((metadata) => metadata.id)).toEqual(["shared", "shared"]);
	});

	it("sorts listed sessions by current filesystem modification time", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const newestCwd = join(root, "workspaces", "newest");
		const oldestCwd = join(root, "workspaces", "oldest");
		const newest = await repository.create({ id: "newest", cwd: newestCwd });
		const newestMetadata = await newest.getMetadata();
		const oldest = await repository.create({ id: "oldest", cwd: oldestCwd });
		const oldestMetadata = await oldest.getMetadata();
		const newestTime = new Date(1_700_000_002_000);
		const oldestTime = new Date(1_700_000_001_000);
		utimesSync(newestMetadata.path, newestTime, newestTime);
		utimesSync(oldestMetadata.path, oldestTime, oldestTime);

		const listed = await repository.list();

		expect(listed.map((metadata) => metadata.id)).toEqual(["newest", "oldest"]);
		expect((await repository.list({ cwd: newestCwd })).map((metadata) => metadata.id)).toEqual(["newest"]);
		expect(listed.map((metadata) => metadata.modifiedAt)).toEqual([
			statSync(newestMetadata.path).mtimeMs,
			statSync(oldestMetadata.path).mtimeMs,
		]);
	});

	it("writes one line per mutation and restores the shared sequence", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const session = await repository.create({ id: "session", cwd: root });
		const metadata = await session.getMetadata();
		const entryId = await session.appendCustomEntry("note", { value: 1 });
		await session.createLane("thread", entryId);
		await session.appendRecord({
			type: "operation_started",
			id: "run",
			lane: "thread",
			sourceLeafId: null,
			intent: { kind: "run", originalPrompt: [], initialMessages: [] },
		});
		await session.setName("Example");
		await session.setLabel(entryId, "checkpoint");
		await session.moveLane("main", null);

		const lines = readFileSync(metadata.path, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines.map((line) => line.kind)).toEqual(["header", "entry", "lane", "record", "fact", "fact", "lane"]);
		expect(lines.slice(1).map((line) => line.seq)).toEqual([1, 2, 3, 4, 5, 6]);

		const reopenedRepository = createRepository(root);
		const reopened = await reopenedRepository.open(metadata);
		expect(await reopened.getLanes()).toEqual([
			{ lane: "main", leafId: null },
			{ lane: "thread", leafId: entryId },
		]);
		expect(await reopened.getName()).toBe("Example");
		expect(await reopened.getLabel(entryId)).toBe("checkpoint");
		expect((await reopened.findRecords()).map((record) => record.id)).toEqual(["run"]);
		expect(
			(
				await reopened.findRecords({
					type: "operation_started",
					operationKind: "run",
				})
			).map((record) => record.id),
		).toEqual(["run"]);
		expect((await reopened.findOpenOperations("thread", { limit: 2 })).map((record) => record.id)).toEqual(["run"]);
		expect((await reopened.getLog()).map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(
			(
				await reopened.appendRecord({
					type: "operation_finished",
					id: "finish",
					lane: "thread",
					runId: "run",
					outcome: "completed",
				})
			).seq,
		).toBe(7);
		expect(await reopened.findOpenOperations("thread", { limit: 2 })).toEqual([]);
	});

	it("recomputes fork message counts when reopening", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const source = await repository.create({ id: "source", cwd: root });
		await source.appendMessage({ role: "user", content: [{ type: "text", text: "one" }], timestamp: 1 });
		await source.appendMessage({ role: "user", content: [{ type: "text", text: "two" }], timestamp: 2 });
		const fork = await repository.fork(await source.getMetadata(), { id: "fork", cwd: root });
		const metadata = await fork.getMetadata();

		const reopenedRepository = createRepository(root);
		const reopened = await reopenedRepository.open(metadata);
		expect((await reopened.getStats()).messageCount).toBe(2);
		await reopened.appendMessage({ role: "user", content: [{ type: "text", text: "three" }], timestamp: 3 });
		expect((await reopened.getStats()).messageCount).toBe(3);

		const verificationRepository = createRepository(root);
		const verified = await verificationRepository.open(metadata);
		expect((await verified.getStats()).messageCount).toBe(3);
	});

	it("reopens a tree fork with its lanes and facts", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const source = await repository.create({ id: "source", cwd: root });
		const rootId = await source.appendCustomEntry("root");
		await source.createLane("thread", rootId);
		const mainId = await source.appendCustomEntry("main");
		const threadEntry = await source.appendEntry({ type: "custom", id: "thread", customType: "thread" }, "thread");
		const threadId = threadEntry.id;
		await source.setName("Source");
		await source.setLabel(threadId, "tip");
		const fork = await repository.fork(await source.getMetadata(), { scope: "tree", id: "fork", cwd: root });
		const metadata = await fork.getMetadata();

		const importedEntryLines = readFileSync(metadata.path, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((line) => line.kind === "entry");
		expect(importedEntryLines.map((line) => "lane" in line)).toEqual([false, false, false]);

		const reopenedRepository = createRepository(root);
		const reopened = await reopenedRepository.open(metadata);
		expect((await reopened.findEntries({ order: "oldestFirst" })).map((entry) => entry.id)).toEqual([
			rootId,
			mainId,
			threadId,
		]);
		expect(await reopened.getLanes()).toEqual([
			{ lane: "main", leafId: mainId },
			{ lane: "thread", leafId: threadId },
		]);
		expect(await reopened.getName()).toBe("Source");
		expect(await reopened.getLabel(threadId)).toBe("tip");
		expect(await reopened.findRecords()).toEqual([]);
	});

	it("does not publish a partial fork when staging fails", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repository = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const source = await repository.create({ id: "source", cwd: root });
		await source.appendMessage({ role: "user", content: [{ type: "text", text: "one" }], timestamp: 1 });
		await source.appendMessage({ role: "user", content: [{ type: "text", text: "two" }], timestamp: 2 });
		const sourceMetadata = await source.getMetadata();
		const appendFile = env.appendFile.bind(env);
		vi.spyOn(env, "appendFile")
			.mockImplementationOnce(appendFile)
			.mockResolvedValueOnce({
				ok: false,
				error: new FileError("unknown", "injected staging failure"),
			});

		await expect(repository.fork(sourceMetadata, { id: "fork", cwd: root })).rejects.toMatchObject({
			code: "storage",
		});

		expect((await repository.list()).map((metadata) => metadata.id)).toEqual(["source"]);
		expect(readdirSync(dirname(sourceMetadata.path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("does not publish a fork when atomic rename fails", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repository = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const source = await repository.create({ id: "source", cwd: root });
		await source.appendMessage({ role: "user", content: [{ type: "text", text: "one" }], timestamp: 1 });
		const sourceMetadata = await source.getMetadata();
		vi.spyOn(env, "renameFile").mockResolvedValueOnce({
			ok: false,
			error: new FileError("unknown", "injected rename failure"),
		});

		await expect(repository.fork(sourceMetadata, { id: "fork", cwd: root })).rejects.toMatchObject({
			code: "storage",
		});

		expect((await repository.list()).map((metadata) => metadata.id)).toEqual(["source"]);
		expect(readdirSync(dirname(sourceMetadata.path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("repairs a valid final line missing its newline", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const session = await repository.create({ id: "session", cwd: root });
		const metadata = await session.getMetadata();
		const firstId = await session.appendCustomEntry("first");
		const unterminated = readFileSync(metadata.path, "utf8").trimEnd();
		writeFileSync(metadata.path, unterminated);

		const reopenedRepository = createRepository(root);
		const reopened = await reopenedRepository.open(metadata);
		expect(readFileSync(metadata.path, "utf8")).toBe(`${unterminated}\n`);
		const secondId = await reopened.appendCustomEntry("second");

		const verificationRepository = createRepository(root);
		const verified = await verificationRepository.open(metadata);
		expect((await verified.findEntries({ order: "oldestFirst" })).map((entry) => entry.id)).toEqual([
			firstId,
			secondId,
		]);
	});

	it("fails to open when repairing a missing final newline fails", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const session = await repository.create({ id: "session", cwd: root });
		const metadata = await session.getMetadata();
		await session.appendCustomEntry("first");
		writeFileSync(metadata.path, readFileSync(metadata.path, "utf8").trimEnd());

		const env = new NodeExecutionEnv({ cwd: root });
		vi.spyOn(env, "appendFile").mockResolvedValueOnce({
			ok: false,
			error: new FileError("permission_denied", "repair denied", metadata.path),
		});
		const failingRepository = new JsonlSessionRepo({
			fs: env,
			sessionsRoot: root,
		});

		await expect(failingRepository.open(metadata)).rejects.toMatchObject({
			code: "storage",
			cause: { code: "permission_denied" },
		});
	});

	it("truncates a malformed final line", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const session = await repository.create({ id: "session", cwd: root });
		const metadata = await session.getMetadata();
		await session.appendCustomEntry("note", { value: "kept" });
		const validPrefix = readFileSync(metadata.path, "utf8");
		appendFileSync(metadata.path, '{"kind":"entry"');

		const reopenedRepository = createRepository(root);
		const reopened = await reopenedRepository.open(metadata);
		expect((await reopened.findEntries()).map((entry) => entry.id)).toHaveLength(1);
		expect(readFileSync(metadata.path, "utf8")).toBe(validPrefix);
		const appendedId = await reopened.appendCustomEntry("after-recovery");
		expect((await reopened.getEntry(appendedId))?.seq).toBe(2);
	});

	it("rejects a malformed middle line without modifying the file", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const session = await repository.create({ id: "session", cwd: root });
		const metadata = await session.getMetadata();
		await session.appendCustomEntry("first");
		await session.appendCustomEntry("second");
		const lines = readFileSync(metadata.path, "utf8").trimEnd().split("\n");
		const corrupted = `${lines[0]}\n${lines[1]}\nnot-json\n${lines[2]}\n`;
		writeFileSync(metadata.path, corrupted);

		const reopenedRepository = createRepository(root);
		await expect(reopenedRepository.open(metadata)).rejects.toMatchObject({ code: "invalid_entry" });
		expect(readFileSync(metadata.path, "utf8")).toBe(corrupted);
	});

	it("rejects an imported entry that references a missing parent", async () => {
		const root = createTempDir();
		const path = join(root, "session-missing-parent.jsonl");
		const header = { kind: "header", version: 4, id: "missing-parent", createdAt: 1, cwd: root };
		const entry = {
			kind: "entry",
			type: "custom",
			id: "orphan",
			customType: "note",
			parentId: "missing",
			seq: 1,
			timestamp: 1,
		};
		writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
		const metadata = {
			id: header.id,
			createdAt: header.createdAt,
			path,
			cwd: root,
			modifiedAt: statSync(path).mtimeMs,
			sourceFormat: 4 as const,
		};

		const repository = createRepository(root);
		await expect(repository.open(metadata)).rejects.toMatchObject({
			code: "invalid_entry",
			message: expect.stringContaining("references missing parent missing"),
		});
	});

	it("rejects a lane-bound entry that does not chain to the lane leaf", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const session = await repository.create({ id: "session", cwd: root });
		const metadata = await session.getMetadata();
		await session.appendCustomEntry("first");
		await session.appendCustomEntry("second");

		const lines = readFileSync(metadata.path, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		lines[2].parentId = null;
		writeFileSync(metadata.path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

		const reopenedRepository = createRepository(root);
		await expect(reopenedRepository.open(metadata)).rejects.toMatchObject({
			code: "invalid_entry",
			message: expect.stringContaining("does not chain to the lane leaf"),
		});
	});

	it("does not move a lane for an imported entry without lane metadata", async () => {
		const root = createTempDir();
		const path = join(root, "session-import.jsonl");
		const header = { kind: "header", version: 4, id: "import", createdAt: 1, cwd: root };
		const importedEntry = {
			kind: "entry",
			type: "custom",
			id: "imported",
			customType: "note",
			parentId: null,
			seq: 1,
			timestamp: 1,
		};
		writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(importedEntry)}\n`);
		const metadata = {
			id: header.id,
			createdAt: header.createdAt,
			path,
			cwd: root,
			modifiedAt: statSync(path).mtimeMs,
			sourceFormat: 4 as const,
		};

		const importedRepository = createRepository(root);
		const imported = await importedRepository.open(metadata);
		expect(await imported.getLeafId()).toBeNull();
		expect((await imported.findEntries()).map((entry) => entry.id)).toEqual(["imported"]);

		appendFileSync(path, `${JSON.stringify({ kind: "lane", seq: 2, lane: "main", leafId: "imported" })}\n`);
		const movedRepository = createRepository(root);
		const moved = await movedRepository.open(metadata);
		expect(await moved.getLeafId()).toBe("imported");
	});

	it.each([
		{
			name: "a non-consecutive sequence",
			message: "non-consecutive seq",
			mutations: [
				{ kind: "entry", type: "custom", id: "entry", customType: "note", parentId: null, seq: 2, timestamp: 1 },
			],
		},
		{
			name: "a duplicate entry/record id",
			message: "duplicate id",
			mutations: [
				{
					kind: "entry",
					type: "custom",
					id: "duplicate",
					customType: "note",
					parentId: null,
					seq: 1,
					timestamp: 1,
				},
				{
					kind: "record",
					type: "operation_started",
					id: "duplicate",
					lane: "main",
					seq: 2,
					timestamp: 2,
					sourceLeafId: null,
					intent: { kind: "run", originalPrompt: [], initialMessages: [] },
				},
			],
		},
		{
			name: "an entry with a missing parent",
			message: "missing parent",
			mutations: [
				{
					kind: "entry",
					type: "custom",
					id: "entry",
					customType: "note",
					parentId: "missing",
					seq: 1,
					timestamp: 1,
				},
			],
		},
		{
			name: "an entry referencing a missing lane",
			message: "missing lane",
			mutations: [
				{
					kind: "entry",
					lane: "thread",
					type: "custom",
					id: "entry",
					customType: "note",
					parentId: null,
					seq: 1,
					timestamp: 1,
				},
			],
		},
		{
			name: "a record referencing a missing lane",
			message: "missing lane",
			mutations: [
				{
					kind: "record",
					type: "operation_started",
					id: "run",
					lane: "thread",
					seq: 1,
					timestamp: 1,
					sourceLeafId: null,
					intent: { kind: "run", originalPrompt: [], initialMessages: [] },
				},
			],
		},
		{
			name: "a lane move referencing a missing entry",
			message: "missing lane target",
			mutations: [{ kind: "lane", lane: "thread", leafId: "missing", seq: 1 }],
		},
		{
			name: "a label referencing a missing entry",
			message: "missing label target",
			mutations: [{ kind: "fact", fact: "label", targetId: "missing", label: "checkpoint", seq: 1 }],
		},
	])("rejects $name during replay", async ({ name, message, mutations }) => {
		const root = createTempDir();
		const metadata = writeRawSession(root, name.replace(/[^A-Za-z0-9._-]/g, "-"), mutations);

		await expect(createRepository(root).open(metadata)).rejects.toMatchObject({
			code: "invalid_entry",
			message: expect.stringContaining(message),
		});
	});

	it("rejects a complete malformed interior mutation without modifying the file", async () => {
		const root = createTempDir();
		const metadata = writeRawSession(root, "malformed-interior", [
			{
				kind: "record",
				type: "operation_started",
				id: "run",
				lane: "main",
				seq: 1,
				timestamp: 1,
				sourceLeafId: null,
			},
			{ kind: "fact", fact: "name", name: "after", seq: 2 },
		]);
		const corrupted = readFileSync(metadata.path, "utf8");

		await expect(createRepository(root).open(metadata)).rejects.toMatchObject({ code: "invalid_entry" });
		expect(readFileSync(metadata.path, "utf8")).toBe(corrupted);
	});

	it("preserves the session when staging torn-tail repair fails", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const session = await repository.create({ id: "repair-failure", cwd: root });
		const metadata = await session.getMetadata();
		await session.appendCustomEntry("kept");
		appendFileSync(metadata.path, '{"kind":"entry"');
		const original = readFileSync(metadata.path, "utf8");

		const env = new NodeExecutionEnv({ cwd: root });
		const writeFile = env.writeFile.bind(env);
		vi.spyOn(env, "writeFile").mockImplementationOnce(async (path: string) => {
			const damaged = await writeFile(path, "");
			if (!damaged.ok) return damaged;
			return {
				ok: false,
				error: new FileError("unknown", "repair interrupted after truncation", path),
			};
		});
		const failingRepository = new JsonlSessionRepo({ fs: env, sessionsRoot: root });

		await expect(failingRepository.open(metadata)).rejects.toMatchObject({ code: "storage" });
		expect(readFileSync(metadata.path, "utf8")).toBe(original);
		expect(existsSync(`${metadata.path}.tmp`)).toBe(false);
	});
});
