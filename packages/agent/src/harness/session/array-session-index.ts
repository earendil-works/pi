import type {
	SessionBranchQuery,
	SessionEntryCursorOptions,
	SessionHead,
	SessionStats,
	SessionTreeEntry,
} from "../types.ts";
import { SessionError } from "../types.ts";

interface SessionEntryProjection {
	name: string | undefined;
	labelsById: Map<string, string>;
	stats: SessionStats;
}

function createProjection(): SessionEntryProjection {
	return {
		name: undefined,
		labelsById: new Map(),
		stats: { messageCount: 0, cachedTokens: 0, uncachedTokens: 0, totalTokens: 0, costTotal: 0 },
	};
}

function applyProjection(projection: SessionEntryProjection, entry: SessionTreeEntry): void {
	if (entry.type === "session_info") {
		projection.name = entry.name?.trim() || undefined;
	} else if (entry.type === "label") {
		const label = entry.label?.trim();
		if (label) projection.labelsById.set(entry.targetId, label);
		else projection.labelsById.delete(entry.targetId);
	}
	if (entry.type === "message") projection.stats.messageCount += 1;
	const usage =
		entry.type === "message"
			? entry.message.role === "assistant"
				? entry.message.usage
				: undefined
			: entry.type === "compaction" || entry.type === "branch_summary"
				? entry.usage
				: undefined;
	if (
		!usage ||
		typeof usage.input !== "number" ||
		typeof usage.output !== "number" ||
		typeof usage.cacheRead !== "number" ||
		typeof usage.cacheWrite !== "number" ||
		typeof usage.cost?.total !== "number"
	) {
		return;
	}
	projection.stats.cachedTokens += usage.cacheRead;
	projection.stats.uncachedTokens += usage.input + usage.cacheWrite;
	projection.stats.totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	projection.stats.costTotal += usage.cost.total;
}

/** Ordered entries and derived projections for array-backed session storage. */
export class ArraySessionIndex {
	private entries: SessionTreeEntry[] = [];
	private byId = new Map<string, SessionTreeEntry>();
	private leafId: string | null = null;
	private projection = createProjection();

	constructor(entries: readonly SessionTreeEntry[] = []) {
		this.replace(entries);
	}

	has(id: string): boolean {
		return this.byId.has(id);
	}

	append(entry: SessionTreeEntry): void {
		if (this.byId.has(entry.id)) {
			throw new SessionError("invalid_entry", `Entry ${entry.id} already exists`);
		}
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.type === "leaf" ? entry.targetId : entry.id;
		applyProjection(this.projection, entry);
	}

	replace(entries: readonly SessionTreeEntry[]): void {
		const nextEntries = [...entries];
		const nextById = new Map<string, SessionTreeEntry>();
		const nextProjection = createProjection();
		let nextLeafId: string | null = null;
		for (const entry of nextEntries) {
			if (nextById.has(entry.id)) {
				throw new SessionError("invalid_entry", `Entry ${entry.id} already exists`);
			}
			nextById.set(entry.id, entry);
			nextLeafId = entry.type === "leaf" ? entry.targetId : entry.id;
			applyProjection(nextProjection, entry);
		}
		this.entries = nextEntries;
		this.byId = nextById;
		this.leafId = nextLeafId;
		this.projection = nextProjection;
	}

	readHead(): SessionHead {
		if (this.leafId !== null && !this.byId.has(this.leafId)) {
			throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
		}
		return { leafId: this.leafId };
	}

	readEntry(id: string): SessionTreeEntry | undefined {
		return this.byId.get(id);
	}

	readEntries(options?: SessionEntryCursorOptions): readonly SessionTreeEntry[] {
		const start = options?.afterEntrySeq ?? 0;
		const end = options?.limit === undefined ? undefined : start + options.limit;
		return this.entries.slice(start, end);
	}

	findEntriesOnBranch(query: SessionBranchQuery & { start: string | null }): readonly SessionTreeEntry[] {
		if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit <= 0)) {
			throw new RangeError("Session branch query limit must be a positive integer");
		}
		if (query.start === null) return [];
		const pathFromStart: SessionTreeEntry[] = [];
		const visited = new Set<string>();
		let current = this.byId.get(query.start);
		if (!current) throw new SessionError("not_found", `Entry ${query.start} not found`);
		while (current) {
			if (visited.has(current.id)) {
				throw new SessionError("invalid_session", `Session branch contains a cycle at ${current.id}`);
			}
			visited.add(current.id);
			pathFromStart.push(current);
			if (query.order !== "oldestFirst" && (current.id === query.stopAtId || current.type === query.stopAtType)) {
				break;
			}
			if (!current.parentId) break;
			const parent = this.byId.get(current.parentId);
			if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			current = parent;
		}
		const traversal = query.order === "oldestFirst" ? pathFromStart.reverse() : pathFromStart;
		const stopIndex =
			query.order === "oldestFirst"
				? traversal.findIndex((entry) => entry.id === query.stopAtId || entry.type === query.stopAtType)
				: -1;
		const bounded = stopIndex === -1 ? traversal : traversal.slice(0, stopIndex + 1);
		const entries = bounded.filter(
			(entry) =>
				(query.type === undefined || entry.type === query.type) &&
				(query.customType === undefined || (entry.type === "custom" && entry.customType === query.customType)),
		);
		return query.limit === undefined ? entries : entries.slice(0, query.limit);
	}

	getLabel(id: string): string | undefined {
		return this.projection.labelsById.get(id);
	}

	getName(): string | undefined {
		return this.projection.name;
	}

	getStats(): SessionStats {
		return { ...this.projection.stats };
	}

	readPathToRootOrCompaction(requestedLeafId: string | null): readonly SessionTreeEntry[] {
		if (requestedLeafId === null) return [];
		const path: SessionTreeEntry[] = [];
		let stopAtEntryId: string | null = null;
		let current = this.byId.get(requestedLeafId);
		if (!current) throw new SessionError("not_found", `Entry ${requestedLeafId} not found`);
		while (current) {
			path.push(current);
			if (stopAtEntryId !== null && current.id === stopAtEntryId) break;
			if (current.type === "compaction") {
				if (current.retainedTail) break;
				stopAtEntryId = current.firstKeptEntryId ?? null;
			}
			if (!current.parentId) break;
			const parent = this.byId.get(current.parentId);
			if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			current = parent;
		}
		return path.reverse();
	}
}
