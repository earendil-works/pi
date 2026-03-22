import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const STALE_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const cleanupTimestamps = new Map<string, number>();

export interface TempOutputCapture {
	path: string;
	write(chunk: string | Buffer): void;
	close(): void;
}

function getCandidateTempDirs(): string[] {
	const candidates = [process.env.TMPDIR, process.env.TMP, process.env.TEMP, tmpdir(), join(homedir(), "tmp")];
	const seen = new Set<string>();
	const dirs: string[] = [];

	for (const candidate of candidates) {
		if (!candidate) continue;
		const normalized = resolve(candidate);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		dirs.push(normalized);
	}

	return dirs;
}

function maybeCleanupStaleLogs(dir: string, prefix: string, suffix: string): void {
	const now = Date.now();
	const lastCleanup = cleanupTimestamps.get(dir);
	if (lastCleanup !== undefined && now - lastCleanup < CLEANUP_INTERVAL_MS) {
		return;
	}
	cleanupTimestamps.set(dir, now);

	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}

	const currentUid = process.getuid?.();
	for (const entry of entries) {
		if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) continue;

		const filePath = join(dir, entry);
		try {
			const stats = statSync(filePath);
			if (!stats.isFile()) continue;
			if (currentUid !== undefined && stats.uid !== currentUid) continue;
			if (now - stats.mtimeMs < STALE_LOG_MAX_AGE_MS) continue;
			unlinkSync(filePath);
		} catch {
			// Ignore races, permission errors, and broken temp entries.
		}
	}
}

function isRecoverableTempError(error: unknown): boolean {
	return error instanceof Error && "code" in error
		? error.code === "ENOSPC" ||
				error.code === "ENOENT" ||
				error.code === "EACCES" ||
				error.code === "EPERM" ||
				error.code === "EROFS" ||
				error.code === "EMFILE"
		: false;
}

export function createTempOutputCapture(prefix: string, suffix: string): TempOutputCapture | undefined {
	for (const dir of getCandidateTempDirs()) {
		try {
			mkdirSync(dir, { recursive: true });
			maybeCleanupStaleLogs(dir, prefix, suffix);
		} catch (error) {
			if (isRecoverableTempError(error)) {
				continue;
			}
			throw error;
		}

		for (let attempt = 0; attempt < 3; attempt += 1) {
			const filePath = join(dir, `${prefix}${randomBytes(8).toString("hex")}${suffix}`);
			try {
				const fd = openSync(filePath, "wx", 0o600);
				const stream = createWriteStream(filePath, { fd });
				let writable = true;
				stream.on("error", () => {
					writable = false;
					stream.destroy();
				});

				return {
					path: filePath,
					write(chunk) {
						if (!writable) return;
						stream.write(chunk);
					},
					close() {
						if (!writable) return;
						writable = false;
						stream.end();
					},
				};
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "EEXIST") {
					continue;
				}
				if (isRecoverableTempError(error)) {
					break;
				}
				throw error;
			}
		}
	}

	return undefined;
}
