import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME } from "../config.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";

export type ProjectTrustDecision = boolean | null;

type TrustFile = Record<string, boolean | null | undefined>;

const CONTEXT_FILE_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function normalizeCwd(cwd: string): string {
	return canonicalizePath(resolvePath(cwd));
}

function readTrustFile(path: string): TrustFile {
	if (!existsSync(path)) {
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read trust store ${path}: ${message}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid trust store ${path}: expected an object`);
	}

	const data: TrustFile = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (value !== true && value !== false && value !== null) {
			throw new Error(`Invalid trust store ${path}: value for ${JSON.stringify(key)} must be true, false, or null`);
		}
		data[key] = value;
	}
	return data;
}

function writeTrustFile(path: string, data: TrustFile): void {
	const sorted: TrustFile = {};
	for (const key of Object.keys(data).sort()) {
		const value = data[key];
		if (value === true || value === false || value === null) {
			sorted[key] = value;
		}
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, "utf-8");
}

function acquireTrustLockSync(path: string): () => void {
	const trustDir = dirname(path);
	mkdirSync(trustDir, { recursive: true });
	const maxAttempts = 10;
	const delayMs = 20;
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return lockfile.lockSync(trustDir, { realpath: false, lockfilePath: `${path}.lock` });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === maxAttempts) {
				throw error;
			}
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {
				// Sleep synchronously to avoid changing trust store callers to async.
			}
		}
	}

	if (lastError instanceof Error) {
		throw lastError;
	}
	throw new Error("Failed to acquire trust store lock");
}

function withTrustFileLock<T>(path: string, fn: () => T): T {
	const release = acquireTrustLockSync(path);
	try {
		return fn();
	} finally {
		release();
	}
}

export function hasProjectTrustInputs(cwd: string): boolean {
	let currentDir = resolvePath(cwd);
	if (existsSync(join(currentDir, CONFIG_DIR_NAME))) {
		return true;
	}

	const root = resolve("/");
	while (true) {
		for (const filename of CONTEXT_FILE_NAMES) {
			if (existsSync(join(currentDir, filename))) {
				return true;
			}
		}
		if (existsSync(join(currentDir, ".agents", "skills"))) {
			return true;
		}

		if (currentDir === root) {
			return false;
		}

		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) {
			return false;
		}
		currentDir = parentDir;
	}
}

export class ProjectTrustStore {
	private trustPath: string;

	constructor(agentDir: string) {
		this.trustPath = join(resolvePath(agentDir), "trust.json");
	}

	get(cwd: string): ProjectTrustDecision {
		return withTrustFileLock(this.trustPath, () => {
			const data = readTrustFile(this.trustPath);
			const value = data[normalizeCwd(cwd)];
			return value === true || value === false ? value : null;
		});
	}

	set(cwd: string, decision: ProjectTrustDecision): void {
		withTrustFileLock(this.trustPath, () => {
			const data = readTrustFile(this.trustPath);
			const key = normalizeCwd(cwd);
			if (decision === null) {
				delete data[key];
			} else {
				data[key] = decision;
			}
			writeTrustFile(this.trustPath, data);
		});
	}
}
