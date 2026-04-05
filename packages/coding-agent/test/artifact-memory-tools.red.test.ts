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
});
