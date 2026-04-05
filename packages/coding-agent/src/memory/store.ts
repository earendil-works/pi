import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface ArtifactMemoryEntryInput {
	kind: string;
	summary: string;
	workspaceRef: string;
	artifacts?: string[];
	sourceRefs?: string[];
	supersedes?: string;
}

export interface ArtifactMemoryEntry extends ArtifactMemoryEntryInput {
	id: string;
	timestamp: string;
}

export const ARTIFACT_MEMORY_GLOBAL_SCOPE = "__mu_global__";

export type ArtifactMemoryScope = "workspace" | "global";

export function isArtifactMemoryGlobalScopeRef(workspaceRef: string): boolean {
	return workspaceRef === ARTIFACT_MEMORY_GLOBAL_SCOPE;
}

export function getArtifactMemoryScope(workspaceRef: string): ArtifactMemoryScope {
	return isArtifactMemoryGlobalScopeRef(workspaceRef) ? "global" : "workspace";
}

export function normalizeArtifactMemoryWorkspaceRef(workspaceRef: string): string {
	if (isArtifactMemoryGlobalScopeRef(workspaceRef)) {
		return ARTIFACT_MEMORY_GLOBAL_SCOPE;
	}
	const resolvedWorkspaceRef = resolve(workspaceRef);
	try {
		return realpathSync.native(resolvedWorkspaceRef);
	} catch {
		return resolvedWorkspaceRef;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function requireString(value: unknown, field: string, lineNumber: number): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Invalid artifact memory entry on line ${lineNumber}: ${field} must be a non-empty string`);
	}
	return value;
}

function parseOptionalStringArray(value: unknown, field: string, lineNumber: number): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`Invalid artifact memory entry on line ${lineNumber}: ${field} must be a string[]`);
	}
	return value;
}

function parseOptionalString(value: unknown, field: string, lineNumber: number): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(
			`Invalid artifact memory entry on line ${lineNumber}: ${field} must be a non-empty string when present`,
		);
	}
	return value;
}

function parseArtifactMemoryEntry(line: string, lineNumber: number): ArtifactMemoryEntry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid artifact memory entry on line ${lineNumber}: ${message}`);
	}

	if (!isRecord(parsed)) {
		throw new Error(`Invalid artifact memory entry on line ${lineNumber}: expected an object`);
	}

	return {
		id: requireString(parsed.id, "id", lineNumber),
		timestamp: requireString(parsed.timestamp, "timestamp", lineNumber),
		kind: requireString(parsed.kind, "kind", lineNumber),
		summary: requireString(parsed.summary, "summary", lineNumber),
		workspaceRef: requireString(parsed.workspaceRef, "workspaceRef", lineNumber),
		artifacts: parseOptionalStringArray(parsed.artifacts, "artifacts", lineNumber),
		sourceRefs: parseOptionalStringArray(parsed.sourceRefs, "sourceRefs", lineNumber),
		supersedes: parseOptionalString(parsed.supersedes, "supersedes", lineNumber),
	};
}

export function getArtifactMemoryRoot(baseDir?: string): string {
	return baseDir ? resolve(baseDir, ".mu", "wiki") : resolve(join(homedir(), ".mu", "wiki"));
}

export function getArtifactMemoryLedgerPath(baseDir?: string): string {
	return join(getArtifactMemoryRoot(baseDir), "entries.jsonl");
}

export function readArtifactMemoryEntries(baseDir?: string): ArtifactMemoryEntry[] {
	const ledgerPath = getArtifactMemoryLedgerPath(baseDir);
	if (!existsSync(ledgerPath)) {
		return [];
	}

	const trimmed = readFileSync(ledgerPath, "utf8").trim();
	if (trimmed.length === 0) {
		return [];
	}

	return trimmed.split("\n").map((line, index) => parseArtifactMemoryEntry(line, index + 1));
}

export class ArtifactMemoryStore {
	private readonly baseDir?: string;

	constructor(options: { baseDir?: string } = {}) {
		this.baseDir = options.baseDir;
	}

	async appendEntry(input: ArtifactMemoryEntryInput): Promise<ArtifactMemoryEntry> {
		const entry: ArtifactMemoryEntry = {
			id: `mem-${randomUUID()}`,
			timestamp: new Date().toISOString(),
			kind: input.kind,
			summary: input.summary,
			workspaceRef: normalizeArtifactMemoryWorkspaceRef(input.workspaceRef),
			artifacts: input.artifacts,
			sourceRefs: input.sourceRefs,
			supersedes: input.supersedes,
		};

		const ledgerPath = getArtifactMemoryLedgerPath(this.baseDir);
		mkdirSync(dirname(ledgerPath), { recursive: true });
		appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
		return entry;
	}

	async listEntries(): Promise<ArtifactMemoryEntry[]> {
		return readArtifactMemoryEntries(this.baseDir);
	}

	async readEntry(id: string): Promise<ArtifactMemoryEntry | null> {
		return readArtifactMemoryEntries(this.baseDir).find((entry) => entry.id === id) ?? null;
	}
}
