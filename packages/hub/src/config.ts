import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as logger from "./logger.ts";

export const PI_DIR = process.env.PI_HUB_PI_DIR || path.join(os.homedir(), ".pi");
export const PROFILES_FILE = process.env.PI_HUB_PROFILES_FILE || path.join(PI_DIR, "profiles.json");
// Source agent dir: pi itself honours PI_CODING_AGENT_DIR, so pi-hub does too
export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(PI_DIR, "agent");
export const PI_HUB_DIR = process.env.PI_HUB_DIR || path.join(PI_DIR, "pi-hub");
export const PROFILE_DIRS_DIR = path.join(PI_HUB_DIR, "profiles");
export const AGENT_SETTINGS_FILE = path.join(AGENT_DIR, "settings.json");
export const AGENT_AUTH_FILE = path.join(AGENT_DIR, "auth.json");
// pi also reads an outer ~/.pi/settings.json; pi-hub copies its "skills" key into
// generated profile settings as insurance when PI_CODING_AGENT_DIR isolation hides it
export const PI_SETTINGS_FILE = path.join(PI_DIR, "settings.json");

export function ensureFile(filePath: string, defaultContent: string): void {
	if (!fs.existsSync(filePath)) {
		logger.debug(`ensureFile: creating ${filePath}`);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, defaultContent, "utf-8");
	}
}

export function readJson<T = unknown>(filePath: string): T {
	logger.debug(`readJson: ${filePath}`);
	let lastErr: unknown;
	for (let attempt = 1; attempt <= 4; attempt++) {
		try {
			return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
		} catch (err) {
			lastErr = err;
			// A concurrent non-atomic writer (upstream pi's settings persistence
			// uses truncate-then-write) can leave the file momentarily empty or
			// partial; wait out the write window before giving up.
			if (attempt < 4) sleepSync(25);
		}
	}
	throw lastErr;
}

export function writeJson(filePath: string, data: unknown, mode?: number): void {
	logger.debug(`writeJson: ${filePath}`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	// Atomic via same-dir tmp + rename: parallel pi processes re-materializing
	// the same profile read these files between writes (e.g. readSourceSettings
	// during writeModelsFile), and a plain truncate-then-write would expose an
	// empty file mid-write.
	const tmpPath = `${filePath}.tmp-${process.pid}`;
	try {
		fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", { mode });
		fs.renameSync(tmpPath, filePath);
	} catch (err) {
		fs.rmSync(tmpPath, { force: true });
		throw err;
	}
	if (mode !== undefined) fs.chmodSync(filePath, mode);
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function ensureProfilesFile(): void {
	ensureFile(PROFILES_FILE, '{"profiles":{}}\n');
}
