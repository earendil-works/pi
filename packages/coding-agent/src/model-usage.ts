import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

export interface ModelUsageStats {
	count: number;
	lastUsed: number;
}

interface FileMetadata {
	size: number;
	mtimeMs: number;
}

interface ModelUsageCacheFile {
	version: 1;
	sessionDir: string;
	files: Record<string, FileMetadata>;
	stats: Record<string, ModelUsageStats>;
}

export function getModelUsageKey(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

export function getWorkspaceSessionDir(projectPath?: string): string {
	const cwd = projectPath ? resolve(projectPath) : process.cwd();
	const safePath = "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
	const configDir = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent/"));
	return join(configDir, "sessions", safePath);
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
		files: record.files as Record<string, FileMetadata>,
		stats: record.stats as Record<string, ModelUsageStats>,
	};
}

function buildFileMetadata(
	sessionDir: string,
	files: string[],
): { meta: Map<string, FileMetadata>; complete: boolean } {
	const meta = new Map<string, FileMetadata>();
	let complete = true;

	for (const file of files) {
		const filePath = join(sessionDir, file);
		try {
			const stat = statSync(filePath);
			meta.set(file, { size: stat.size, mtimeMs: stat.mtimeMs });
		} catch {
			complete = false;
		}
	}

	return { meta, complete };
}

function cacheMatches(cache: ModelUsageCacheFile, sessionDir: string, metadata: Map<string, FileMetadata>): boolean {
	if (cache.sessionDir !== sessionDir) return false;
	const cachedFiles = Object.keys(cache.files);
	if (cachedFiles.length !== metadata.size) return false;

	for (const [fileName, fileMeta] of metadata.entries()) {
		const cached = cache.files[fileName];
		if (!cached) return false;
		if (cached.size !== fileMeta.size) return false;
		if (cached.mtimeMs !== fileMeta.mtimeMs) return false;
	}

	return true;
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

function writeCacheFile(
	cachePath: string,
	sessionDir: string,
	metadata: Map<string, FileMetadata>,
	stats: Map<string, ModelUsageStats>,
): void {
	const files: Record<string, FileMetadata> = {};
	for (const [fileName, fileMeta] of metadata.entries()) {
		files[fileName] = { size: fileMeta.size, mtimeMs: fileMeta.mtimeMs };
	}

	const cache: ModelUsageCacheFile = {
		version: 1,
		sessionDir,
		files,
		stats: statsMapToRecord(stats),
	};

	try {
		writeFileSync(cachePath, JSON.stringify(cache));
	} catch {
		// Ignore cache write failures
	}
}

export function loadModelUsageStats(sessionDir: string): Map<string, ModelUsageStats> {
	const stats = new Map<string, ModelUsageStats>();
	if (!existsSync(sessionDir)) return stats;

	let files: string[] = [];
	try {
		files = readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl"));
	} catch {
		return stats;
	}

	const cachePath = getCachePath(sessionDir);
	const { meta: metadata, complete } = buildFileMetadata(sessionDir, files);
	if (complete) {
		const cached = readCacheFile(cachePath);
		if (cached && cacheMatches(cached, sessionDir, metadata)) {
			return statsRecordToMap(cached.stats);
		}
	}

	for (const file of files) {
		const filePath = join(sessionDir, file);
		let content = "";
		try {
			content = readFileSync(filePath, "utf8");
		} catch {
			continue;
		}

		if (!content.trim()) continue;
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}

			if (typeof entry !== "object" || entry === null) continue;
			const record = entry as Record<string, unknown>;
			const type = record.type;
			if (type !== "session" && type !== "model_change") continue;

			const provider = record.provider;
			const modelId = record.modelId;
			const timestamp = record.timestamp;
			if (typeof provider !== "string" || typeof modelId !== "string" || typeof timestamp !== "string") continue;

			const ts = Date.parse(timestamp);
			if (!Number.isFinite(ts)) continue;

			const key = getModelUsageKey(provider, modelId);
			const previous = stats.get(key);
			const nextCount = (previous?.count ?? 0) + 1;
			const nextLastUsed = Math.max(previous?.lastUsed ?? 0, ts);
			stats.set(key, { count: nextCount, lastUsed: nextLastUsed });
		}
	}

	if (complete) {
		writeCacheFile(cachePath, sessionDir, metadata, stats);
	}

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
