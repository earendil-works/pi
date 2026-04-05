import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type ArtifactMemoryEntry,
	getArtifactMemoryRoot,
	normalizeArtifactMemoryWorkspaceRef,
	readArtifactMemoryEntries,
} from "./store.js";

export interface WorkspaceProjection {
	workspaceRef: string;
	entries: ArtifactMemoryEntry[];
	startupSummary: string;
}

function getWorkspaceProjectionKey(workspaceRef: string): string {
	return createHash("sha256").update(normalizeArtifactMemoryWorkspaceRef(workspaceRef)).digest("hex").slice(0, 12);
}

function summarizeEntries(entries: ArtifactMemoryEntry[]): string {
	if (entries.length === 0) {
		return "No stored memory for this workspace.";
	}

	return entries.map((entry) => `- [${entry.kind}] ${entry.summary}`).join("\n");
}

export function getArtifactMemoryProjectionPath(workspaceRef: string, baseDir?: string): string {
	return join(getArtifactMemoryRoot(baseDir), "projections", `${getWorkspaceProjectionKey(workspaceRef)}.json`);
}

export class ArtifactMemoryProjector {
	private readonly baseDir?: string;

	constructor(options: { baseDir?: string } = {}) {
		this.baseDir = options.baseDir;
	}

	async buildWorkspaceProjection(workspaceRef: string): Promise<WorkspaceProjection> {
		const resolvedWorkspaceRef = normalizeArtifactMemoryWorkspaceRef(workspaceRef);
		const entries = readArtifactMemoryEntries(this.baseDir).filter(
			(entry) => entry.workspaceRef === resolvedWorkspaceRef,
		);
		const projection: WorkspaceProjection = {
			workspaceRef: resolvedWorkspaceRef,
			entries,
			startupSummary: summarizeEntries(entries),
		};

		const projectionPath = getArtifactMemoryProjectionPath(resolvedWorkspaceRef, this.baseDir);
		mkdirSync(dirname(projectionPath), { recursive: true });
		writeFileSync(projectionPath, `${JSON.stringify(projection, null, 2)}\n`, "utf8");
		return projection;
	}
}
