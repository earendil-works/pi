import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../../src/harness/env/nodejs.ts";
import {
	InMemorySessionStorage,
	type JsonlSessionListOptions,
	JsonlSessionRepo,
	type JsonlSessionRepoOptions,
	Session,
	type SessionMetadata,
	type SessionStorage,
} from "../../../src/harness/session/index.ts";
import { listJsonlSessionMetadata, loadJsonlSessionStorage } from "../../../src/harness/session/jsonl/repo.ts";
import { createScanningSessionSearch } from "../../../src/search/index.ts";
import type { AgentMessage } from "../../../src/types.ts";

interface WorkspaceMetadata extends SessionMetadata {
	cwd: string;
}

const tempDirs: string[] = [];

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-agent-search-"));
	tempDirs.push(directory);
	return directory;
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function message(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function createMemorySession(metadata: WorkspaceMetadata): Session<WorkspaceMetadata> {
	return new Session<WorkspaceMetadata>(
		new InMemorySessionStorage(metadata) as unknown as SessionStorage<WorkspaceMetadata>,
	);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of iterable) items.push(item);
	return items;
}

async function* jsonlReadables(options: JsonlSessionRepoOptions, query: JsonlSessionListOptions = {}) {
	for (const metadata of await listJsonlSessionMetadata(options, query)) {
		yield loadJsonlSessionStorage(options, metadata);
	}
}

describe("session search", () => {
	it("scans an arbitrary in-memory projected source", async () => {
		const root = createMemorySession({ id: "root", createdAt: 1, cwd: "/repo" });
		await root.appendMessage(message("fix auth flow"));
		const other = createMemorySession({ id: "other", createdAt: 2, cwd: "/other" });
		await other.appendMessage(message("auth in another workspace"));
		const search = createScanningSessionSearch([root, other]);

		expect("apply" in search).toBe(false);
		expect(await collect(search.search("auth"))).toMatchObject([{ sessionId: "root" }, { sessionId: "other" }]);
		expect(await collect(search.search("missing"))).toEqual([]);
	});

	it("includes labels in memory scanning projections", async () => {
		const session = createMemorySession({ id: "session", createdAt: 1, cwd: "/repo" });
		const entryId = await session.appendMessage(message("plain body"));
		await session.setLabel(entryId, "important label");
		const search = createScanningSessionSearch([session]);

		expect(await collect(search.search("important"))).toMatchObject([{ sessionId: "session", entryId }]);
	});

	it("honors entry type filters and abort signals in scanning search", async () => {
		const session = createMemorySession({ id: "session", createdAt: 1, cwd: "/repo" });
		const messageEntryId = await session.appendMessage(message("auth message"));
		await session.appendCustomEntry("note", { text: "auth custom" });
		const search = createScanningSessionSearch([session]);

		expect(await collect(search.search("auth", { entryTypes: ["message"] }))).toMatchObject([
			{ sessionId: "session", entryId: messageEntryId },
		]);

		const controller = new AbortController();
		controller.abort();
		await expect(collect(search.search("auth", { signal: controller.signal }))).rejects.toMatchObject({
			name: "AbortError",
		});
	});

	it("scans JSONL sessions from disk through the JSONL scanning source", async () => {
		const root = createTempDir();
		const options = { fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root };
		const repository = new JsonlSessionRepo(options);
		const cwd = join(root, "workspace");
		const otherCwd = join(root, "other");
		const session = await repository.create({ id: "jsonl", cwd });
		const entryId = await session.appendMessage(message("jsonl backed auth entry"));
		await session.setLabel(entryId, "disk label");
		const other = await repository.create({ id: "other", cwd: otherCwd });
		const otherEntryId = await other.appendMessage(message("jsonl backed auth entry in another cwd"));
		const search = createScanningSessionSearch((query?: JsonlSessionListOptions) => jsonlReadables(options, query));

		const authHits = await collect(search.search("auth"));
		expect(authHits).toHaveLength(2);
		expect(authHits).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sessionId: "jsonl",
					entryId,
				}),
				expect.objectContaining({
					sessionId: "other",
					entryId: otherEntryId,
				}),
			]),
		);
		expect(await collect(search.search("disk"))).toMatchObject([{ sessionId: "jsonl", entryId }]);
	});
});
