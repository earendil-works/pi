import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type ArtifactMemoryEntry,
	getArtifactMemoryRoot,
	normalizeArtifactMemoryWorkspaceRef,
	readArtifactMemoryEntries,
} from "./store.js";

export interface WorkspaceProjectionMeta {
	totalEntries: number;
	activeEntries: number;
	deletedCount: number;
	supersededCount: number;
}

export interface WorkspaceProjection {
	workspaceRef: string;
	entries: ArtifactMemoryEntry[];
	startupItems: WorkspaceProjectionItem[];
	startupSummary: string;
	meta: WorkspaceProjectionMeta;
}

export interface WorkspaceProjectionItem {
	id: string;
	kind: string;
	label: string;
	timestamp: string;
}

function getWorkspaceProjectionKey(workspaceRef: string): string {
	return createHash("sha256").update(normalizeArtifactMemoryWorkspaceRef(workspaceRef)).digest("hex").slice(0, 12);
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateLabel(value: string, maxLength = 60): string {
	return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function toTitleCase(value: string): string {
	return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

function buildProjectionLabel(entry: ArtifactMemoryEntry): string {
	const summary = entry.summary.trim();
	const singleLine = normalizeWhitespace(summary.replace(/\n/g, " "));

	const fileWriteMatch = summary.match(/Successfully wrote\s+\d+\s+bytes to\s+(.+)/i);
	if (fileWriteMatch) {
		const normalizedPath = normalizeWhitespace(fileWriteMatch[1]);
		const fileName = normalizedPath.split(/[\\/]/).pop() ?? normalizedPath;
		return truncateLabel(`Wrote ${fileName}`);
	}

	const nameMatch = summary.match(/Name:\s*([^\n]+)/i);
	if (nameMatch) {
		return truncateLabel(nameMatch[1].trim());
	}

	const prefixMatch = summary.match(/^([^:\n]{4,80}):/);
	if (prefixMatch) {
		return truncateLabel(prefixMatch[1].trim());
	}

	return truncateLabel(singleLine);
}

function buildStartupItems(entries: ArtifactMemoryEntry[]): WorkspaceProjectionItem[] {
	const seen = new Set<string>();
	const items: WorkspaceProjectionItem[] = [];

	for (const entry of entries) {
		const label = buildProjectionLabel(entry);
		const key = `${entry.kind}:${label.toLowerCase()}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		items.push({
			id: entry.id,
			kind: entry.kind,
			label,
			timestamp: entry.timestamp,
		});
	}

	return items;
}

function summarizeEntries(entries: ArtifactMemoryEntry[]): string {
	const items = buildStartupItems(entries);
	if (items.length === 0) {
		return "No stored memory for this workspace.";
	}

	const grouped = new Map<string, WorkspaceProjectionItem[]>();
	for (const item of items) {
		const bucket = grouped.get(item.kind) ?? [];
		bucket.push(item);
		grouped.set(item.kind, bucket);
	}

	return Array.from(grouped.entries())
		.map(([kind, kindItems]) => {
			const lines = [toTitleCase(kind)];
			for (const item of kindItems) {
				lines.push(`- ${item.label}`);
			}
			return lines.join("\n");
		})
		.join("\n\n");
}

export interface FilterActiveEntriesResult {
	activeEntries: ArtifactMemoryEntry[];
	meta: WorkspaceProjectionMeta;
}

export function filterActiveEntries(entries: ArtifactMemoryEntry[]): FilterActiveEntriesResult {
	const deletedOrSuperseded = new Set<string>();
	for (const entry of entries) {
		const event = entry.event ?? "create";
		if ((event === "update" || event === "delete") && entry.targetId && entry.targetId !== entry.id) {
			deletedOrSuperseded.add(entry.targetId);
		}
	}

	const activeEntries = entries.filter((entry) => {
		const event = entry.event ?? "create";
		if (event === "delete") return false;
		if (deletedOrSuperseded.has(entry.id)) return false;
		return true;
	});

	const deletedCount = entries.filter((e) => e.event === "delete").length;

	const meta: WorkspaceProjectionMeta = {
		totalEntries: entries.length,
		activeEntries: activeEntries.length,
		deletedCount,
		supersededCount: deletedOrSuperseded.size,
	};

	return { activeEntries, meta };
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
		const { activeEntries, meta } = filterActiveEntries(entries);
		const projection: WorkspaceProjection = {
			workspaceRef: resolvedWorkspaceRef,
			entries: activeEntries,
			startupItems: buildStartupItems(activeEntries),
			startupSummary: summarizeEntries(activeEntries),
			meta,
		};

		const projectionPath = getArtifactMemoryProjectionPath(resolvedWorkspaceRef, this.baseDir);
		mkdirSync(dirname(projectionPath), { recursive: true });
		writeFileSync(projectionPath, `${JSON.stringify(projection, null, 2)}\n`, "utf8");
		return projection;
	}
}
