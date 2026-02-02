import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

export interface ModelUsageStats {
	count: number;
	lastUsed: number;
}

interface ModelUsageSnapshotFile {
	version: 1;
	updatedAt: number;
	stats: Record<string, ModelUsageStats>;
}

const MODEL_USAGE_SNAPSHOT_FILENAME = ".model-usage-stats.json";

interface ModelUsageCacheFile {
	version: 1;
	sessionDir: string;
	files: Record<string, { size: number; mtimeMs: number }>;
	stats: Record<string, ModelUsageStats>;
}

export function getModelUsageKey(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

export function getWorkspaceSessionDir(projectPath?: string): string {
	const cwd = projectPath ? resolve(projectPath) : process.cwd();
	const safePath = "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
	const configDir = resolve(process.env.MU_CODING_AGENT_DIR || join(homedir(), ".mu/agent/"));
	return join(configDir, "sessions", safePath);
}

function getSnapshotPath(sessionDir: string): string {
	return join(sessionDir, MODEL_USAGE_SNAPSHOT_FILENAME);
}

function ensureDirExists(dir: string): boolean {
	try {
		mkdirSync(dir, { recursive: true });
		return true;
	} catch {
		return false;
	}
}

function readSnapshotFile(snapshotPath: string): Map<string, ModelUsageStats> | null {
	if (!existsSync(snapshotPath)) return null;

	let raw = "";
	try {
		raw = readFileSync(snapshotPath, "utf8");
	} catch {
		return null;
	}

	if (!raw.trim()) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	if (record.version !== 1) return null;
	if (typeof record.stats !== "object" || record.stats === null) return null;

	const statsRecord = record.stats as Record<string, unknown>;
	const stats = new Map<string, ModelUsageStats>();
	for (const [key, value] of Object.entries(statsRecord)) {
		if (typeof value !== "object" || value === null) continue;
		const v = value as Record<string, unknown>;
		const count = v.count;
		const lastUsed = v.lastUsed;
		if (typeof count !== "number" || !Number.isFinite(count)) continue;
		if (typeof lastUsed !== "number" || !Number.isFinite(lastUsed)) continue;
		stats.set(key, { count, lastUsed });
	}

	return stats;
}

function writeSnapshotFile(snapshotPath: string, stats: Map<string, ModelUsageStats>): void {
	const snapshot: ModelUsageSnapshotFile = {
		version: 1,
		updatedAt: Date.now(),
		stats: statsMapToRecord(stats),
	};

	const tmpPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tmpPath, JSON.stringify(snapshot), "utf8");
		renameSync(tmpPath, snapshotPath);
	} catch {
		// Best-effort: ignore snapshot write failures
	}
}

/**
 * Record a single model usage event for this workspace (count + lastUsed).
 * Stored in the workspace session directory under mu config (e.g. ~/.mu/agent/sessions/<workspace>/).
 */
export function recordModelUsage(sessionDir: string, provider: string, modelId: string, timestampMs: number): void {
	if (!ensureDirExists(sessionDir)) return;

	const snapshotPath = getSnapshotPath(sessionDir);
	const stats = readSnapshotFile(snapshotPath) ?? new Map<string, ModelUsageStats>();

	const key = getModelUsageKey(provider, modelId);
	const previous = stats.get(key);
	const nextCount = (previous?.count ?? 0) + 1;
	const nextLastUsed = Math.max(previous?.lastUsed ?? 0, timestampMs);
	stats.set(key, { count: nextCount, lastUsed: nextLastUsed });

	writeSnapshotFile(snapshotPath, stats);
}

function getCachePath(sessionDir: string): string {
	return join(sessionDir, ".model-usage-cache.json");
}

function readCacheFile(cachePath: string): ModelUsageCacheFile | null {
	if (!existsSync(cachePath)) return null;
	let raw = "";
	try {
		raw = readFileSync(cachePath, "utf8");
	} catch {
		return null;
	}

	if (!raw.trim()) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	if (record.version !== 1) return null;
	if (typeof record.sessionDir !== "string") return null;
	if (typeof record.files !== "object" || record.files === null) return null;
	if (typeof record.stats !== "object" || record.stats === null) return null;

	return {
		version: 1,
		sessionDir: record.sessionDir as string,
		files: record.files as Record<string, { size: number; mtimeMs: number }>,
		stats: record.stats as Record<string, ModelUsageStats>,
	};
}

function statsRecordToMap(stats: Record<string, ModelUsageStats>): Map<string, ModelUsageStats> {
	const map = new Map<string, ModelUsageStats>();
	for (const [key, value] of Object.entries(stats)) {
		if (!value) continue;
		map.set(key, { count: value.count, lastUsed: value.lastUsed });
	}
	return map;
}

function statsMapToRecord(stats: Map<string, ModelUsageStats>): Record<string, ModelUsageStats> {
	const record: Record<string, ModelUsageStats> = {};
	for (const [key, value] of stats.entries()) {
		record[key] = { count: value.count, lastUsed: value.lastUsed };
	}
	return record;
}

export function loadModelUsageStats(sessionDir: string): Map<string, ModelUsageStats> {
	const stats = new Map<string, ModelUsageStats>();
	if (!existsSync(sessionDir)) return stats;

	// Fast path: prefer snapshot to keep /model selector <= 100ms.
	const snapshot = readSnapshotFile(getSnapshotPath(sessionDir));
	if (snapshot) return snapshot;

	// Seed from legacy scan cache if present (fast to parse).
	const legacy = readCacheFile(getCachePath(sessionDir));
	if (legacy) {
		const seeded = statsRecordToMap(legacy.stats);
		// Best-effort: write snapshot so future loads stay fast even if legacy cache changes.
		writeSnapshotFile(getSnapshotPath(sessionDir), seeded);
		return seeded;
	}

	// No snapshot and no legacy cache: return empty (caller falls back to provider/id ordering).
	return stats;
}

export function compareModelUsage(
	a: { provider: string; id: string },
	b: { provider: string; id: string },
	usageByKey: Map<string, ModelUsageStats>,
	mode: "recency" | "frequency",
): number {
	const keyA = getModelUsageKey(a.provider, a.id);
	const keyB = getModelUsageKey(b.provider, b.id);
	const usageA = usageByKey.get(keyA);
	const usageB = usageByKey.get(keyB);
	const countA = usageA?.count ?? 0;
	const countB = usageB?.count ?? 0;
	const lastUsedA = usageA?.lastUsed ?? 0;
	const lastUsedB = usageB?.lastUsed ?? 0;

	if (mode === "frequency" && countA !== countB) {
		return countB - countA;
	}

	if (lastUsedA !== lastUsedB) {
		return lastUsedB - lastUsedA;
	}

	if (mode === "recency" && countA !== countB) {
		return countB - countA;
	}

	const providerCompare = a.provider.localeCompare(b.provider);
	return providerCompare !== 0 ? providerCompare : a.id.localeCompare(b.id);
}
