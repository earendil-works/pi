import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

export interface ModelUsageStats {
	count: number;
	lastUsed: number;
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

export function loadModelUsageStats(sessionDir: string): Map<string, ModelUsageStats> {
	const stats = new Map<string, ModelUsageStats>();
	if (!existsSync(sessionDir)) return stats;

	let files: string[] = [];
	try {
		files = readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl"));
	} catch {
		return stats;
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
