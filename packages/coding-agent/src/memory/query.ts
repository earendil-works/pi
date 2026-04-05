import { findRepoRoot } from "../utils/find-repo-root.js";
import {
	ARTIFACT_MEMORY_GLOBAL_SCOPE,
	type ArtifactMemoryEntry,
	type ArtifactMemoryScope,
	ArtifactMemoryStore,
	getArtifactMemoryScope,
	normalizeArtifactMemoryWorkspaceRef,
} from "./store.js";

export interface ArtifactMemorySearchHit {
	entry: ArtifactMemoryEntry;
	score: number;
	inWorkspace: boolean;
}

export type ArtifactMemorySearchMode = "workspace_first" | ArtifactMemoryScope;

function tokenizeQuery(query: string): string[] {
	return query
		.toLowerCase()
		.split(/\s+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function getWorkspaceRef(workspaceRef?: string): string {
	return normalizeArtifactMemoryWorkspaceRef(
		findRepoRoot(workspaceRef ?? process.cwd()) ?? workspaceRef ?? process.cwd(),
	);
}

function resolveSearchMode(scope?: ArtifactMemoryScope): ArtifactMemorySearchMode {
	return scope ?? "workspace_first";
}

function scoreEntry(entry: ArtifactMemoryEntry, tokens: string[]): number {
	const haystack = [entry.kind, entry.summary, ...(entry.artifacts ?? []), ...(entry.sourceRefs ?? [])]
		.join("\n")
		.toLowerCase();

	let score = 0;
	for (const token of tokens) {
		if (haystack.includes(token)) {
			score += 1;
		}
	}
	return score;
}

export async function searchArtifactMemory(params: {
	query: string;
	scope?: ArtifactMemoryScope;
	workspaceRef?: string;
	limit?: number;
	baseDir?: string;
}): Promise<ArtifactMemorySearchHit[]> {
	const tokens = tokenizeQuery(params.query);
	if (tokens.length === 0) {
		return [];
	}

	const requestedWorkspace = getWorkspaceRef(params.workspaceRef);
	const searchMode = resolveSearchMode(params.scope);
	const store = new ArtifactMemoryStore({ baseDir: params.baseDir });
	const entries = await store.listEntries();
	const hits = entries
		.map((entry) => {
			const score = scoreEntry(entry, tokens);
			const entryScope = getArtifactMemoryScope(entry.workspaceRef);
			return {
				entry,
				score,
				inWorkspace: entry.workspaceRef === requestedWorkspace,
				entryScope,
			};
		})
		.filter((hit) => {
			if (hit.score <= 0) {
				return false;
			}
			if (searchMode === "workspace") {
				return hit.entry.workspaceRef === requestedWorkspace;
			}
			if (searchMode === "global") {
				return hit.entry.workspaceRef === ARTIFACT_MEMORY_GLOBAL_SCOPE;
			}
			return true;
		})
		.sort((left, right) => {
			if (searchMode === "workspace_first" && left.inWorkspace !== right.inWorkspace) {
				return left.inWorkspace ? -1 : 1;
			}
			if (left.score !== right.score) {
				return right.score - left.score;
			}
			return right.entry.timestamp.localeCompare(left.entry.timestamp);
		});

	return hits.slice(0, params.limit ?? 10);
}

export async function readArtifactMemoryEntry(params: {
	entryId: string;
	scope?: ArtifactMemoryScope;
	workspaceRef?: string;
	baseDir?: string;
}): Promise<ArtifactMemoryEntry | null> {
	const store = new ArtifactMemoryStore({ baseDir: params.baseDir });
	const entry = await store.readEntry(params.entryId);
	if (!entry) {
		return null;
	}
	if (params.scope === "global") {
		return entry.workspaceRef === ARTIFACT_MEMORY_GLOBAL_SCOPE ? entry : null;
	}
	if (params.scope === "workspace") {
		const workspaceRef = getWorkspaceRef(params.workspaceRef);
		return entry.workspaceRef === workspaceRef ? entry : null;
	}
	return entry;
}

export function getDefaultArtifactMemoryWorkspaceRef(workspaceRef?: string): string {
	return getWorkspaceRef(workspaceRef);
}

export function getArtifactMemoryScopeWorkspaceRef(params: {
	scope?: ArtifactMemoryScope;
	workspaceRef?: string;
}): string {
	if (params.scope === "global") {
		return ARTIFACT_MEMORY_GLOBAL_SCOPE;
	}
	return getWorkspaceRef(params.workspaceRef);
}
