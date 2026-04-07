import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface ArtifactMemoryEntry {
	id: string;
	timestamp: string;
	kind: string;
	summary: string;
	workspaceRef: string;
	artifacts?: string[];
	sourceRefs?: string[];
	supersedes?: string;
	event?: "create" | "update" | "delete";
	targetId?: string;
}

interface WorkspaceProjectionMeta {
	totalEntries: number;
	activeEntries: number;
	deletedCount: number;
	supersededCount: number;
}

interface WorkspaceProjection {
	workspaceRef: string;
	entries: ArtifactMemoryEntry[];
	startupSummary: string;
	meta: WorkspaceProjectionMeta;
}

interface FilterActiveEntriesResult {
	activeEntries: ArtifactMemoryEntry[];
	meta: WorkspaceProjectionMeta;
}

type FilterActiveEntriesFunction = (entries: ArtifactMemoryEntry[]) => FilterActiveEntriesResult;

interface ArtifactMemoryProjector {
	buildWorkspaceProjection(workspaceRef: string): Promise<WorkspaceProjection>;
}

interface ArtifactMemoryProjectorModule {
	ArtifactMemoryProjector: new (options: { baseDir?: string }) => ArtifactMemoryProjector;
	filterActiveEntries: FilterActiveEntriesFunction;
}

interface ArtifactMemoryStoreInstance {
	appendEntry(input: Omit<ArtifactMemoryEntry, "id" | "timestamp">): Promise<ArtifactMemoryEntry>;
}

interface ArtifactMemoryStoreModule {
	ArtifactMemoryStore: new (options?: { baseDir?: string }) => ArtifactMemoryStoreInstance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function assertArtifactMemoryProjectorModule(value: unknown): asserts value is ArtifactMemoryProjectorModule {
	if (!isRecord(value)) {
		throw new Error("artifact memory projection module did not load as an object");
	}

	if (typeof value.ArtifactMemoryProjector !== "function") {
		throw new Error("artifact memory projection module is missing ArtifactMemoryProjector");
	}

	if (typeof value.filterActiveEntries !== "function") {
		throw new Error("artifact memory projection module is missing filterActiveEntries");
	}
}

function assertArtifactMemoryStoreModule(value: unknown): asserts value is ArtifactMemoryStoreModule {
	if (!isRecord(value) || typeof value.ArtifactMemoryStore !== "function") {
		throw new Error("artifact memory store module is missing ArtifactMemoryStore");
	}
}

async function loadModules(): Promise<{ projector: ArtifactMemoryProjectorModule; store: ArtifactMemoryStoreModule }> {
	const projectorLoaded: unknown = await import("../src/memory/projection.js");
	const storeLoaded: unknown = await import("../src/memory/store.js");
	assertArtifactMemoryProjectorModule(projectorLoaded);
	assertArtifactMemoryStoreModule(storeLoaded);
	return { projector: projectorLoaded, store: storeLoaded };
}

describe("ArtifactMemoryProjector (red)", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("derives a workspace-specific projection from authoritative entries without making the projection authoritative", async () => {
		const { projector, store } = await loadModules();
		const baseDir = mkdtempSync(join(tmpdir(), "mu-artifact-memory-projection-"));
		tempDirs.push(baseDir);

		const memoryStore = new store.ArtifactMemoryStore({ baseDir });
		await memoryStore.appendEntry({
			kind: "artifact",
			summary: "Workspace alpha generated build output",
			workspaceRef: "/tmp/workspaces/alpha",
			artifacts: ["dist/alpha.js"],
			sourceRefs: ["tool:write"],
		});
		await memoryStore.appendEntry({
			kind: "artifact",
			summary: "Workspace beta generated build output",
			workspaceRef: "/tmp/workspaces/beta",
			artifacts: ["dist/beta.js"],
			sourceRefs: ["tool:write"],
		});

		const memoryProjector = new projector.ArtifactMemoryProjector({ baseDir });
		const alphaProjection = await memoryProjector.buildWorkspaceProjection("/tmp/workspaces/alpha");
		const betaProjection = await memoryProjector.buildWorkspaceProjection("/tmp/workspaces/beta");

		expect(alphaProjection.workspaceRef).toBe("/tmp/workspaces/alpha");
		expect(betaProjection.workspaceRef).toBe("/tmp/workspaces/beta");
		expect(alphaProjection.entries.map((entry) => entry.summary)).toEqual(["Workspace alpha generated build output"]);
		expect(betaProjection.entries.map((entry) => entry.summary)).toEqual(["Workspace beta generated build output"]);
		expect(alphaProjection.startupSummary).toContain("Workspace alpha generated build output");
		expect(betaProjection.startupSummary).not.toContain("Workspace alpha generated build output");
	});
});

describe("filterActiveEntries", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("create → update (supersedes) → expect 1 active entry", async () => {
		const { projector } = await loadModules();
		const entries: ArtifactMemoryEntry[] = [
			{
				id: "mem-1",
				event: "create",
				kind: "workflow",
				summary: "v1",
				workspaceRef: "/ws",
				timestamp: "2024-01-01T00:00:00Z",
			},
			{
				id: "mem-2",
				event: "update",
				kind: "workflow",
				summary: "v2",
				workspaceRef: "/ws",
				timestamp: "2024-01-01T00:01:00Z",
				targetId: "mem-1",
			},
		];
		const { activeEntries, meta } = projector.filterActiveEntries(entries);
		expect(activeEntries.length).toBe(1);
		expect(activeEntries[0].id).toBe("mem-2");
		expect(meta.supersededCount).toBe(1);
		expect(meta.activeEntries).toBe(1);
		expect(meta.totalEntries).toBe(2);
	});

	it("create → delete → expect 0 active entries", async () => {
		const { projector } = await loadModules();
		const entries: ArtifactMemoryEntry[] = [
			{
				id: "mem-1",
				event: "create",
				kind: "workflow",
				summary: "v1",
				workspaceRef: "/ws",
				timestamp: "2024-01-01T00:00:00Z",
			},
			{
				id: "mem-2",
				event: "delete",
				kind: "workflow",
				summary: "",
				workspaceRef: "/ws",
				timestamp: "2024-01-01T00:01:00Z",
				targetId: "mem-1",
			},
		];
		const { activeEntries, meta } = projector.filterActiveEntries(entries);
		expect(activeEntries.length).toBe(0);
		expect(meta.deletedCount).toBe(1);
		expect(meta.activeEntries).toBe(0);
		expect(meta.totalEntries).toBe(2);
	});

	it("A → B updates A → C updates B → expect only C active", async () => {
		const { projector } = await loadModules();
		const entries: ArtifactMemoryEntry[] = [
			{
				id: "A",
				event: "create",
				kind: "task",
				summary: "Task A",
				workspaceRef: "/ws",
				timestamp: "2024-01-01T00:00:00Z",
			},
			{
				id: "B",
				event: "update",
				kind: "task",
				summary: "Task B",
				workspaceRef: "/ws",
				timestamp: "2024-01-01T00:01:00Z",
				targetId: "A",
			},
			{
				id: "C",
				event: "update",
				kind: "task",
				summary: "Task C",
				workspaceRef: "/ws",
				timestamp: "2024-01-01T00:02:00Z",
				targetId: "B",
			},
		];
		const { activeEntries, meta } = projector.filterActiveEntries(entries);
		expect(activeEntries.length).toBe(1);
		expect(activeEntries[0].id).toBe("C");
		expect(meta.supersededCount).toBe(2);
		expect(meta.activeEntries).toBe(1);
		expect(meta.totalEntries).toBe(3);
	});

	it("A (create) + B (create, different summary) + C (update, targets A) → expect 2 active entries (B and C)", async () => {
		const { projector } = await loadModules();
		const entries: ArtifactMemoryEntry[] = [
			{
				id: "A",
				event: "create",
				kind: "note",
				summary: "Note A",
				workspaceRef: "/ws",
				timestamp: "2024-01-01T00:00:00Z",
			},
			{
				id: "B",
				event: "create",
				kind: "note",
				summary: "Note B",
				workspaceRef: "/ws",
				timestamp: "2024-01-01T00:01:00Z",
			},
			{
				id: "C",
				event: "update",
				kind: "note",
				summary: "Note A Updated",
				workspaceRef: "/ws",
				timestamp: "2024-01-01T00:02:00Z",
				targetId: "A",
			},
		];
		const { activeEntries, meta } = projector.filterActiveEntries(entries);
		expect(activeEntries.length).toBe(2);
		const activeIds = activeEntries.map((e) => e.id).sort();
		expect(activeIds).toEqual(["B", "C"]);
		expect(meta.supersededCount).toBe(1);
		expect(meta.activeEntries).toBe(2);
		expect(meta.totalEntries).toBe(3);
	});

	it("Legacy entries without event field are treated as create events", async () => {
		const { projector } = await loadModules();
		const entries: ArtifactMemoryEntry[] = [
			{ id: "mem-1", kind: "workflow", summary: "v1", workspaceRef: "/ws", timestamp: "2024-01-01T00:00:00Z" },
			{ id: "mem-2", kind: "workflow", summary: "v2", workspaceRef: "/ws", timestamp: "2024-01-01T00:01:00Z" },
		];
		const { activeEntries, meta } = projector.filterActiveEntries(entries);
		expect(activeEntries.length).toBe(2);
		expect(meta.supersededCount).toBe(0);
		expect(meta.activeEntries).toBe(2);
		expect(meta.totalEntries).toBe(2);
	});

	it("Self-referential update (A updates A) is ignored, A still appears", async () => {
		const { projector } = await loadModules();
		const entries: ArtifactMemoryEntry[] = [
			{
				id: "A",
				event: "create",
				kind: "note",
				summary: "Note A",
				workspaceRef: "/ws",
				timestamp: "2024-01-01T00:00:00Z",
			},
			{
				id: "B",
				event: "update",
				kind: "note",
				summary: "Note A Updated",
				workspaceRef: "/ws",
				timestamp: "2024-01-01T00:01:00Z",
				targetId: "A",
			},
			{
				id: "C",
				event: "update",
				kind: "note",
				summary: "Note B Updated",
				workspaceRef: "/ws",
				timestamp: "2024-01-01T00:02:00Z",
				targetId: "B",
			},
		];
		const { activeEntries, meta } = projector.filterActiveEntries(entries);
		expect(activeEntries.length).toBe(1);
		expect(activeEntries[0].id).toBe("C");
		expect(meta.supersededCount).toBe(2);
	});

	it("Circular update (A→B, B→A) results in both filtered out (each superseded)", async () => {
		const { projector } = await loadModules();
		const entries: ArtifactMemoryEntry[] = [
			{
				id: "A",
				event: "update",
				kind: "task",
				summary: "Task A",
				workspaceRef: "/ws",
				timestamp: "2024-01-01T00:00:00Z",
				targetId: "B",
			},
			{
				id: "B",
				event: "update",
				kind: "task",
				summary: "Task B",
				workspaceRef: "/ws",
				timestamp: "2024-01-01T00:01:00Z",
				targetId: "A",
			},
		];
		const { activeEntries, meta } = projector.filterActiveEntries(entries);
		// Both have a targetId that is superseded by the other
		// A is superseded by B, B is superseded by A - both get filtered
		expect(activeEntries.length).toBe(0);
		expect(meta.supersededCount).toBe(2);
	});

	it("complex chain: create → update → delete chain", async () => {
		const { projector } = await loadModules();
		const entries: ArtifactMemoryEntry[] = [
			{
				id: "mem-1",
				event: "create",
				kind: "workflow",
				summary: "v1",
				workspaceRef: "/ws",
				timestamp: "2024-01-01T00:00:00Z",
			},
			{
				id: "mem-2",
				event: "update",
				kind: "workflow",
				summary: "v2",
				workspaceRef: "/ws",
				timestamp: "2024-01-01T00:01:00Z",
				targetId: "mem-1",
			},
			{
				id: "mem-3",
				event: "delete",
				kind: "workflow",
				summary: "",
				workspaceRef: "/ws",
				timestamp: "2024-01-01T00:02:00Z",
				targetId: "mem-2",
			},
		];
		const { activeEntries, meta } = projector.filterActiveEntries(entries);
		expect(activeEntries.length).toBe(0);
		expect(meta.supersededCount).toBe(2); // mem-1 and mem-2 are both superseded/deleted
		expect(meta.deletedCount).toBe(1);
		expect(meta.activeEntries).toBe(0);
		expect(meta.totalEntries).toBe(3);
	});

	it("integration: projection excludes deleted and superseded entries", async () => {
		const { projector, store } = await loadModules();
		const baseDir = mkdtempSync(join(tmpdir(), "mu-artifact-memory-projection-"));
		tempDirs.push(baseDir);

		const memoryStore = new store.ArtifactMemoryStore({ baseDir });

		// Create first entry (will be superseded)
		await memoryStore.appendEntry({
			kind: "workflow",
			summary: "Initial workflow",
			workspaceRef: "/tmp/workspace",
		});

		// Add update entry that supersedes it
		const ledgerPath = `${baseDir}/.mu/wiki/entries.jsonl`;
		const fs = await import("node:fs");
		const entry2 = {
			id: "mem-update-1",
			timestamp: new Date().toISOString(),
			event: "update",
			targetId: "mem-xxx", // First entry will have a different ID
			kind: "workflow",
			summary: "Updated workflow",
			workspaceRef: "/tmp/workspace",
		};

		// Read the actual first entry ID from the ledger
		const content = fs.readFileSync(ledgerPath, "utf8");
		const firstEntry = JSON.parse(content.trim().split("\n")[0]);
		entry2.targetId = firstEntry.id;

		fs.appendFileSync(ledgerPath, `${JSON.stringify(entry2)}\n`);

		// Add delete entry
		const entry3 = {
			id: "mem-delete-1",
			timestamp: new Date().toISOString(),
			event: "delete",
			targetId: entry2.id,
			kind: "workflow",
			summary: "Deleted workflow",
			workspaceRef: "/tmp/workspace",
		};
		fs.appendFileSync(ledgerPath, `${JSON.stringify(entry3)}\n`);

		const memoryProjector = new projector.ArtifactMemoryProjector({ baseDir });
		const projection = await memoryProjector.buildWorkspaceProjection("/tmp/workspace");

		expect(projection.entries.length).toBe(0);
		expect(projection.meta.activeEntries).toBe(0);
		expect(projection.meta.deletedCount).toBe(1);
		expect(projection.meta.supersededCount).toBe(2);
		expect(projection.meta.totalEntries).toBe(3);
	});
});
