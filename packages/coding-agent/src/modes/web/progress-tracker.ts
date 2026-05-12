import { type FSWatcher, watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { HttpError } from "./http.js";
import type { Broadcast, ProgressTrackerData, ProgressTrackerTask } from "./types.js";

interface TrackerRegistration {
	sessionFile: string;
	path: string;
	watcher: FSWatcher;
}

export class ProgressTrackerManager {
	private readonly registrations = new Map<string, TrackerRegistration>();
	private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(private readonly broadcast: Broadcast) {}

	async register(inputPath: string, cwd: string, sessionFile: string): Promise<ProgressTrackerData> {
		const resolvedPath = resolveProgressTrackerPath(inputPath, cwd);
		const data = await this.readTracker(sessionFile, resolvedPath);
		this.stop(sessionFile);
		const watcher = watch(resolvedPath, { persistent: false }, () => this.scheduleBroadcast(sessionFile));
		watcher.on("error", () => this.stop(sessionFile));
		this.registrations.set(sessionFile, { sessionFile, path: resolvedPath, watcher });
		this.broadcast({ type: "progress_tracker", ...data });
		return data;
	}

	async state(sessionFile?: string | null): Promise<ProgressTrackerData | null> {
		if (!sessionFile) return null;
		const registration = this.registrations.get(sessionFile);
		if (!registration) return null;
		return this.readTracker(registration.sessionFile, registration.path);
	}

	stop(sessionFile: string): void {
		const registration = this.registrations.get(sessionFile);
		if (!registration) return;
		registration.watcher.close();
		this.registrations.delete(sessionFile);
		const timer = this.debounceTimers.get(sessionFile);
		if (timer) clearTimeout(timer);
		this.debounceTimers.delete(sessionFile);
	}

	remove(sessionFile: string): void {
		this.stop(sessionFile);
		this.broadcast({ type: "progress_tracker_removed", sessionFile });
	}

	stopAll(): void {
		for (const sessionFile of [...this.registrations.keys()]) this.stop(sessionFile);
	}

	private scheduleBroadcast(sessionFile: string): void {
		const existing = this.debounceTimers.get(sessionFile);
		if (existing) clearTimeout(existing);
		this.debounceTimers.set(
			sessionFile,
			setTimeout(() => {
				this.debounceTimers.delete(sessionFile);
				void this.broadcastCurrent(sessionFile);
			}, 80),
		);
	}

	private async broadcastCurrent(sessionFile: string): Promise<void> {
		const data = await this.state(sessionFile).catch(() => null);
		if (data) this.broadcast({ type: "progress_tracker", ...data });
	}

	private async readTracker(sessionFile: string, trackerPath: string): Promise<ProgressTrackerData> {
		const content = await fs.readFile(trackerPath, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") throw new HttpError(404, `Progress tracker not found: ${trackerPath}`);
			throw error;
		});
		return { sessionFile, path: trackerPath, tasks: parseProgressTrackerMarkdown(content) };
	}
}

export function parseProgressTrackerMarkdown(markdown: string): ProgressTrackerTask[] {
	const tasks: ProgressTrackerTask[] = [];
	for (const line of markdown.split(/\r?\n/)) {
		const match = line.match(/^\s*[-*]\s+\[( |x|X|~)\]\s+(.+?)\s*$/);
		if (!match) continue;
		const marker = match[1];
		const text = match[2].trim();
		if (!text) continue;
		tasks.push({
			status: marker === "~" ? "doing" : marker.toLowerCase() === "x" ? "done" : "todo",
			text,
		});
	}
	return tasks;
}

export function resolveProgressTrackerPath(inputPath: string, cwd: string): string {
	const value = String(inputPath || "").trim();
	if (!value) throw new HttpError(400, "Missing progress tracker path");
	const expanded =
		value === "~" || value.startsWith("~/") ? path.join(process.env.HOME || cwd, value.slice(2)) : value;
	const resolvedPath = path.resolve(cwd, expanded);
	if (path.extname(resolvedPath).toLowerCase() !== ".md") {
		throw new HttpError(400, "Progress tracker path must be a .md file");
	}
	return resolvedPath;
}
