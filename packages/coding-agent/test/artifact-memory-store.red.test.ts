import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface ArtifactMemoryEntryInput {
	kind: string;
	summary: string;
	workspaceRef: string;
	artifacts?: string[];
	sourceRefs?: string[];
	supersedes?: string;
}

interface ArtifactMemoryEntry extends ArtifactMemoryEntryInput {
	id: string;
	timestamp: string;
}

interface ArtifactMemoryStoreInstance {
	appendEntry(input: ArtifactMemoryEntryInput): Promise<ArtifactMemoryEntry>;
	listEntries(): Promise<ArtifactMemoryEntry[]>;
	readEntry(id: string): Promise<ArtifactMemoryEntry | null>;
}

interface ArtifactMemoryStoreModule {
	getArtifactMemoryRoot(baseDir?: string): string;
	ArtifactMemoryStore: new (options?: { baseDir?: string }) => ArtifactMemoryStoreInstance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function assertArtifactMemoryStoreModule(value: unknown): asserts value is ArtifactMemoryStoreModule {
	if (!isRecord(value)) {
		throw new Error("artifact memory store module did not load as an object");
	}

	if (typeof value.getArtifactMemoryRoot !== "function") {
		throw new Error("artifact memory store module is missing getArtifactMemoryRoot(baseDir?)");
	}

	if (typeof value.ArtifactMemoryStore !== "function") {
		throw new Error("artifact memory store module is missing ArtifactMemoryStore");
	}
}

async function loadArtifactMemoryStoreModule(): Promise<ArtifactMemoryStoreModule> {
	const loaded: unknown = await import("../src/memory/store.js");
	assertArtifactMemoryStoreModule(loaded);
	return loaded;
}

describe("ArtifactMemoryStore (red)", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("appends authoritative entries to a global append-only store and preserves supersession metadata", async () => {
		const memoryModule = await loadArtifactMemoryStoreModule();
		const baseDir = mkdtempSync(join(tmpdir(), "mu-artifact-memory-store-"));
		tempDirs.push(baseDir);

		const store = new memoryModule.ArtifactMemoryStore({ baseDir });
		const first = await store.appendEntry({
			kind: "artifact",
			summary: "Created startup projection fixture",
			workspaceRef: "/tmp/workspaces/alpha",
			artifacts: ["packages/coding-agent/test/fixtures/alpha.txt"],
			sourceRefs: ["tool:write"],
		});
		const second = await store.appendEntry({
			kind: "decision",
			summary: "Workspace projections are derived views",
			workspaceRef: "/tmp/workspaces/alpha",
			sourceRefs: ["tool:apply_patch"],
			supersedes: first.id,
		});

		const all = await store.listEntries();
		expect(all).toHaveLength(2);
		expect(all[0]?.id).toBe(first.id);
		expect(all[1]?.id).toBe(second.id);
		expect(all[1]?.supersedes).toBe(first.id);
		expect(await store.readEntry(first.id)).toEqual(first);
		expect(memoryModule.getArtifactMemoryRoot(baseDir)).toContain(".mu");
	});
});
