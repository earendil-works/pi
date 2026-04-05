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
}

interface WorkspaceProjection {
	workspaceRef: string;
	entries: ArtifactMemoryEntry[];
	startupSummary: string;
}

interface ArtifactMemoryProjector {
	buildWorkspaceProjection(workspaceRef: string): Promise<WorkspaceProjection>;
}

interface ArtifactMemoryProjectorModule {
	ArtifactMemoryProjector: new (options: { baseDir?: string }) => ArtifactMemoryProjector;
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
