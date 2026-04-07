import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readArtifactMemoryEntry, searchArtifactMemory } from "../src/memory/query.js";
import { allTools } from "../src/tools/index.js";

interface ArtifactMemoryStoreDetails {
	queued?: true;
	taskId?: string;
}

interface ArtifactMemoryToolModule {
	memoryStoreTool: {
		execute(
			toolCallId: string,
			args: {
				kind: string;
				summary: string;
				workspaceRef?: string;
				artifacts?: string[];
				sourceRefs?: string[];
				supersedes?: string;
				delete?: string;
			},
		): Promise<{ details?: ArtifactMemoryStoreDetails }>;
	};
	memorySearchTool: {
		execute(
			toolCallId: string,
			args: { query: string; workspaceRef?: string; limit?: number },
		): Promise<{ content: Array<{ type: "text"; text: string }> }>;
	};
	memoryReadTool: {
		execute(
			toolCallId: string,
			args: { entryId: string; workspaceRef?: string },
		): Promise<{ content: Array<{ type: "text"; text: string }> }>;
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function assertMemoryToolModule(value: unknown): asserts value is ArtifactMemoryToolModule {
	if (!isRecord(value)) {
		throw new Error("memory tool module did not load as an object");
	}
	if (!isRecord(value.memoryStoreTool) || typeof value.memoryStoreTool.execute !== "function") {
		throw new Error("memory tool module is missing memoryStoreTool.execute()");
	}
	if (!isRecord(value.memorySearchTool) || typeof value.memorySearchTool.execute !== "function") {
		throw new Error("memory tool module is missing memorySearchTool.execute()");
	}
	if (!isRecord(value.memoryReadTool) || typeof value.memoryReadTool.execute !== "function") {
		throw new Error("memory tool module is missing memoryReadTool.execute()");
	}
}

async function loadMemoryToolModule(): Promise<ArtifactMemoryToolModule> {
	const loaded: unknown = await import("../src/tools/memory-tools.js");
	assertMemoryToolModule(loaded);
	return loaded;
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 2000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastValue = await fn();
	while (!predicate(lastValue)) {
		if (Date.now() >= deadline) {
			return lastValue;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
		lastValue = await fn();
	}
	return lastValue;
}

describe("artifact memory tools (red)", () => {
	let previousCwd: string;
	let workspaceDir: string;
	let configDir: string;
	let previousConfigDir: string | undefined;

	beforeEach(() => {
		previousCwd = process.cwd();
		workspaceDir = mkdtempSync(join(tmpdir(), "mu-artifact-memory-tools-ws-"));
		configDir = mkdtempSync(join(tmpdir(), "mu-artifact-memory-tools-config-"));
		mkdirSync(join(workspaceDir, ".git"), { recursive: true });
		writeFileSync(join(workspaceDir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
		process.chdir(workspaceDir);
		previousConfigDir = process.env.MU_CODING_AGENT_DIR;
		process.env.MU_CODING_AGENT_DIR = configDir;
	});

	afterEach(() => {
		process.chdir(previousCwd);
		if (previousConfigDir === undefined) {
			delete process.env.MU_CODING_AGENT_DIR;
		} else {
			process.env.MU_CODING_AGENT_DIR = previousConfigDir;
		}
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(configDir, { recursive: true, force: true });
	});

	it("registers memory_store, memory_search, and memory_read and lets the tools round-trip an explicit stored memory", async () => {
		expect(allTools).toHaveProperty("memory_store");
		expect(allTools).toHaveProperty("memory_search");
		expect(allTools).toHaveProperty("memory_read");

		const memoryTools = await loadMemoryToolModule();
		const storeResult = await memoryTools.memoryStoreTool.execute("mem-store", {
			kind: "decision",
			summary: "The launch code is ORANGE-KITE-441",
			sourceRefs: ["explicit:user-request"],
		});
		expect(storeResult.details?.queued).toBe(true);
		expect(storeResult.details?.taskId).toBeTruthy();

		await waitFor(
			() => searchArtifactMemory({ query: "launch code", limit: 5 }),
			(hits) => hits.length > 0,
		);

		const searchResult = await memoryTools.memorySearchTool.execute("mem-search", {
			query: "launch code",
			limit: 5,
		});
		expect(searchResult.content.map((block) => block.text).join("\n")).toContain("ORANGE-KITE-441");
		const hits = await searchArtifactMemory({ query: "launch code", limit: 5 });
		const entryId = hits[0]?.entry.id;
		expect(entryId).toBeTruthy();
		const storedEntry = await readArtifactMemoryEntry({ entryId: entryId ?? "" });
		expect(storedEntry?.summary).toContain("ORANGE-KITE-441");

		const readResult = await memoryTools.memoryReadTool.execute("mem-read", {
			entryId: entryId ?? "",
		});
		expect(readResult.content.map((block) => block.text).join("\n")).toContain("ORANGE-KITE-441");
	});

	it("maps supersedes to event: update and sets targetId", async () => {
		const memoryTools = await loadMemoryToolModule();
		const uniqueId = `supersedes-test-${Date.now()}`;

		// First create an entry to supersede
		const createResult = await memoryTools.memoryStoreTool.execute("mem-store-create", {
			kind: "decision",
			summary: `Original decision ${uniqueId}`,
		});
		expect(createResult.details?.queued).toBe(true);

		// Wait for it to be written
		await waitFor(
			() => searchArtifactMemory({ query: uniqueId, limit: 5 }),
			(hits) => hits.some((h) => h.entry.summary.includes("Original")),
		);

		const hits = await searchArtifactMemory({ query: `Original decision ${uniqueId}`, limit: 5 });
		const originalId = hits.find((h) => h.entry.summary.includes("Original"))?.entry.id;
		expect(originalId).toBeTruthy();

		// Now update it with supersedes
		const updateResult = await memoryTools.memoryStoreTool.execute("mem-store-update", {
			kind: "decision",
			summary: `Updated decision ${uniqueId}`,
			supersedes: originalId,
		});
		expect(updateResult.details?.queued).toBe(true);

		// Wait for the update to be written
		await waitFor(
			() => searchArtifactMemory({ query: uniqueId, limit: 5 }),
			(hits) => hits.some((h) => h.entry.summary.includes("Updated")),
		);

		// Read the update entry and verify event and targetId
		const updateHits = await searchArtifactMemory({ query: `Updated decision ${uniqueId}`, limit: 5 });
		const updateEntryId = updateHits.find((h) => h.entry.summary.includes("Updated"))?.entry.id;
		const storedEntry = await readArtifactMemoryEntry({ entryId: updateEntryId ?? "" });

		expect(storedEntry?.event).toBe("update");
		expect(storedEntry?.targetId).toBe(originalId);
	});

	it("maps delete to event: delete and sets targetId", async () => {
		const memoryTools = await loadMemoryToolModule();
		const uniqueId = `delete-test-${Date.now()}`;

		// First create an entry to delete
		const createResult = await memoryTools.memoryStoreTool.execute("mem-store-create", {
			kind: "note",
			summary: `Note to be deleted ${uniqueId}`,
		});
		expect(createResult.details?.queued).toBe(true);

		// Wait for it to be written
		await waitFor(
			() => searchArtifactMemory({ query: uniqueId, limit: 5 }),
			(hits) => hits.some((h) => h.entry.summary.includes("Note to be deleted")),
		);

		const hits = await searchArtifactMemory({ query: `Note to be deleted ${uniqueId}`, limit: 5 });
		const originalId = hits.find((h) => h.entry.summary.includes("Note to be deleted"))?.entry.id;
		expect(originalId).toBeTruthy();

		// Now delete it
		const deleteResult = await memoryTools.memoryStoreTool.execute("mem-store-delete", {
			kind: "note",
			summary: `Deletion marker ${uniqueId}`,
			delete: originalId,
		});
		expect(deleteResult.details?.queued).toBe(true);

		// Wait for the delete to be written
		await waitFor(
			() => searchArtifactMemory({ query: uniqueId, limit: 5 }),
			(hits) => hits.some((h) => h.entry.event === "delete"),
		);

		// Find the delete entry and verify event and targetId
		const allHits = await searchArtifactMemory({ query: uniqueId, limit: 5 });
		const deleteEntry = allHits.find((h) => h.entry.event === "delete")?.entry;

		expect(deleteEntry?.event).toBe("delete");
		expect(deleteEntry?.targetId).toBe(originalId);
	});

	it("defaults to event: create when neither supersedes nor delete is provided", async () => {
		const memoryTools = await loadMemoryToolModule();
		const uniqueId = `create-test-${Date.now()}`;

		const createResult = await memoryTools.memoryStoreTool.execute("mem-store-create", {
			kind: "observation",
			summary: `Simple create test ${uniqueId}`,
		});
		expect(createResult.details?.queued).toBe(true);

		// Wait for it to be written
		await waitFor(
			() => searchArtifactMemory({ query: uniqueId, limit: 5 }),
			(hits) => hits.some((h) => h.entry.summary.includes("Simple create test")),
		);

		const hits = await searchArtifactMemory({ query: `Simple create test ${uniqueId}`, limit: 5 });
		const entryId = hits.find((h) => h.entry.summary.includes("Simple create test"))?.entry.id;
		const storedEntry = await readArtifactMemoryEntry({ entryId: entryId ?? "" });

		expect(storedEntry?.event).toBe("create");
		expect(storedEntry?.targetId).toBeUndefined();
	});

	it("gives delete precedence when both supersedes and delete are provided", async () => {
		const memoryTools = await loadMemoryToolModule();
		const uniqueId = `mixed-test-${Date.now()}`;

		// Create two entries
		const createResult1 = await memoryTools.memoryStoreTool.execute("mem-store-create1", {
			kind: "task",
			summary: `First task ${uniqueId}`,
		});
		const createResult2 = await memoryTools.memoryStoreTool.execute("mem-store-create2", {
			kind: "task",
			summary: `Second task ${uniqueId}`,
		});
		expect(createResult1.details?.queued).toBe(true);
		expect(createResult2.details?.queued).toBe(true);

		// Wait for both to be written
		await waitFor(
			() => searchArtifactMemory({ query: uniqueId, limit: 10 }),
			(hits) =>
				hits.filter((h) => h.entry.summary.includes("First task")).length > 0 &&
				hits.filter((h) => h.entry.summary.includes("Second task")).length > 0,
		);

		const hits1 = await searchArtifactMemory({ query: `First task ${uniqueId}`, limit: 5 });
		const hits2 = await searchArtifactMemory({ query: `Second task ${uniqueId}`, limit: 5 });
		const firstId = hits1.find((h) => h.entry.summary.includes("First task"))?.entry.id;
		const secondId = hits2.find((h) => h.entry.summary.includes("Second task"))?.entry.id;

		// Store with both supersedes and delete (delete should win)
		const mixedResult = await memoryTools.memoryStoreTool.execute("mem-store-mixed", {
			kind: "task",
			summary: `Mixed operation ${uniqueId}`,
			supersedes: firstId,
			delete: secondId,
		});
		expect(mixedResult.details?.queued).toBe(true);

		// Wait for it to be written
		await waitFor(
			() => searchArtifactMemory({ query: uniqueId, limit: 10 }),
			(hits) => hits.some((h) => h.entry.summary.includes("Mixed operation")),
		);

		const mixedHits = await searchArtifactMemory({ query: `Mixed operation ${uniqueId}`, limit: 5 });
		const mixedEntry = mixedHits.find((h) => h.entry.summary.includes("Mixed operation"))?.entry;

		// Delete takes precedence
		expect(mixedEntry?.event).toBe("delete");
		expect(mixedEntry?.targetId).toBe(secondId);
	});
});
