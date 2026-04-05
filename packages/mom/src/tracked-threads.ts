import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import * as log from "./log.js";

/**
 * Persists channel thread roots where mom has participated (for follow-ups without @mention).
 */
export class TrackedThreadsManager {
	private readonly filePath: string;
	private readonly byChannel = new Map<string, Set<string>>();

	constructor(workingDir: string) {
		this.filePath = join(workingDir, "tracked-threads.json");
	}

	load(): void {
		try {
			if (!existsSync(this.filePath)) return;
			const data = JSON.parse(readFileSync(this.filePath, "utf-8")) as Record<string, string[]>;
			this.byChannel.clear();
			for (const [channelId, threads] of Object.entries(data)) {
				this.byChannel.set(channelId, new Set(threads));
			}
			const n = [...this.byChannel.values()].reduce((a, s) => a + s.size, 0);
			if (n > 0) log.logInfo(`Loaded ${n} tracked thread(s)`);
		} catch (err) {
			log.logWarning("Failed to load tracked threads", String(err));
		}
	}

	private save(): void {
		try {
			const data: Record<string, string[]> = {};
			for (const [channelId, threads] of this.byChannel) {
				data[channelId] = Array.from(threads);
			}
			writeFileSync(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
		} catch (err) {
			log.logWarning("Failed to save tracked threads", String(err));
		}
	}

	track(channelId: string, threadRootTs: string): void {
		let set = this.byChannel.get(channelId);
		if (!set) {
			set = new Set();
			this.byChannel.set(channelId, set);
		}
		if (!set.has(threadRootTs)) {
			set.add(threadRootTs);
			this.save();
			log.logInfo(`[${channelId}] Now tracking thread ${threadRootTs}`);
		}
	}

	isTracked(channelId: string, threadTs: string | undefined): boolean {
		if (!threadTs) return false;
		return this.byChannel.get(channelId)?.has(threadTs) ?? false;
	}
}
