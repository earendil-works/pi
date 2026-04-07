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
	event?: "create" | "update" | "delete";
	targetId?: string;
}

interface ArtifactMemoryStoreInstance {
	appendEntry(input: ArtifactMemoryEntryInput): Promise<ArtifactMemoryEntry>;
	listEntries(): Promise<ArtifactMemoryEntry[]>;
	readEntry(id: string): Promise<ArtifactMemoryEntry | null>;
}

interface ArtifactMemoryStoreModule {
	getArtifactMemoryRoot(baseDir?: string): string;
	ArtifactMemoryStore: new (options?: { baseDir?: string }) => ArtifactMemoryStoreInstance;
	parseArtifactMemoryEntry(line: string, lineNumber: number): ArtifactMemoryEntry;
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

	if (typeof value.parseArtifactMemoryEntry !== "function") {
		throw new Error("artifact memory store module is missing parseArtifactMemoryEntry");
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

	describe("parseArtifactMemoryEntry event/targetId extension", () => {
		it("parses entry with event='create'", async () => {
			const memoryModule = await loadArtifactMemoryStoreModule();
			const baseDir = mkdtempSync(join(tmpdir(), "mu-artifact-memory-store-"));
			tempDirs.push(baseDir);

			const store = new memoryModule.ArtifactMemoryStore({ baseDir });
			const entry = await store.appendEntry({
				kind: "workflow",
				summary: "test",
				workspaceRef: "/ws",
			});

			const all = await store.listEntries();
			expect(all).toHaveLength(1);
			expect(all[0]?.event).toBeUndefined();
			expect(all[0]?.targetId).toBeUndefined();
		});

		it("parses JSONL with event='create' field", async () => {
			const memoryModule = await loadArtifactMemoryStoreModule();
			const line =
				'{"id":"mem-1","timestamp":"2026-01-01","kind":"workflow","summary":"test","workspaceRef":"/ws","event":"create"}';
			const entry = memoryModule.parseArtifactMemoryEntry(line, 1);
			expect(entry.event).toBe("create");
			expect(entry.targetId).toBeUndefined();
		});

		it("parses JSONL with event='update' and targetId", async () => {
			const memoryModule = await loadArtifactMemoryStoreModule();
			const line =
				'{"id":"mem-2","timestamp":"2026-01-01","kind":"workflow","summary":"test","workspaceRef":"/ws","event":"update","targetId":"mem-0"}';
			const entry = memoryModule.parseArtifactMemoryEntry(line, 1);
			expect(entry.event).toBe("update");
			expect(entry.targetId).toBe("mem-0");
		});

		it("parses JSONL with event='delete' and targetId", async () => {
			const memoryModule = await loadArtifactMemoryStoreModule();
			const line =
				'{"id":"mem-3","timestamp":"2026-01-01","kind":"workflow","summary":"test","workspaceRef":"/ws","event":"delete","targetId":"mem-0"}';
			const entry = memoryModule.parseArtifactMemoryEntry(line, 1);
			expect(entry.event).toBe("delete");
			expect(entry.targetId).toBe("mem-0");
		});

		it("parses legacy JSONL without event/targetId (backward compatibility)", async () => {
			const memoryModule = await loadArtifactMemoryStoreModule();
			const line = '{"id":"mem-4","timestamp":"2026-01-01","kind":"workflow","summary":"test","workspaceRef":"/ws"}';
			const entry = memoryModule.parseArtifactMemoryEntry(line, 1);
			expect(entry.event).toBeUndefined();
			expect(entry.targetId).toBeUndefined();
		});

		it("throws on invalid event value", async () => {
			const memoryModule = await loadArtifactMemoryStoreModule();
			const line =
				'{"id":"mem-5","timestamp":"2026-01-01","kind":"workflow","summary":"test","workspaceRef":"/ws","event":"invalid"}';
			expect(() => memoryModule.parseArtifactMemoryEntry(line, 1)).toThrow(
				'event must be "create", "update", or "delete"',
			);
		});
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
