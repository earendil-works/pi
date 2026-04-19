import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export type ProcessType = "worker" | "bash" | "verifier";
export type ProcessStatus = "pending" | "running" | "completed" | "exited" | "killed" | "failed";

export interface ProcessEntry {
	processName: string;
	type: ProcessType;
	pid: number;
	status: ProcessStatus;
	sessionId?: string;
	sessionFile?: string;
	jobId?: string;
	command?: string;
	verificationChecks?: string[];
	exitCode?: number;
	createdAt: string;
	updatedAt: string;
}

export interface RegisterOptions {
	type: ProcessType;
	pid: number;
	name: string;
	sessionId?: string;
	sessionFile?: string;
	jobId?: string;
	command?: string;
	verificationChecks?: string[];
}

export interface UpdateStatusOptions {
	exitCode?: number;
}

export interface QueryFilters {
	name?: string;
	status?: ProcessStatus;
	type?: ProcessType;
}

export interface ProcessRegistryOptions {
	/** Path to the JSONL registry file. Defaults to ~/.mu/process-registry.jsonl */
	registryPath?: string;
	/** Age threshold in ms for prune(). Defaults to 24 hours. */
	pruneAgeMs?: number;
	/** Custom clock for testing */
	now?: () => number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES: ReadonlySet<ProcessStatus> = new Set(["exited", "killed", "failed", "completed"]);

function isTerminalStatus(status: ProcessStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

/**
 * Resolve a name collision by appending #2, #3, etc.
 * If the base name already ends with #N, increment N; otherwise append #2.
 */
function disambiguateName(existingNames: ReadonlySet<string>, base: string): string {
	if (!existingNames.has(base)) return base;

	// Check if base already has a #N suffix
	const suffixMatch = base.match(/^(.+)#(\d+)$/);
	if (suffixMatch) {
		const stem = suffixMatch[1];
		let counter = Number(suffixMatch[2]) + 1;
		while (existingNames.has(`${stem}#${counter}`)) {
			counter++;
		}
		return `${stem}#${counter}`;
	}

	// No suffix yet — start at #2
	let counter = 2;
	while (existingNames.has(`${base}#${counter}`)) {
		counter++;
	}
	return `${base}#${counter}`;
}

/**
 * Check if a PID is alive by sending signal 0.
 * Returns true if the process exists and we can signal it.
 */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read the command line of a PID from /proc (Linux) or ps (macOS/Linux).
 * Returns undefined if it cannot be determined.
 */
function getPidCommand(pid: number): string | undefined {
	// Try /proc first (Linux)
	try {
		if (existsSync(`/proc/${pid}/cmdline`)) {
			const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
			// /proc/PID/cmdline uses null bytes as separators
			return cmdline.replace(/\0/g, " ").trim() || undefined;
		}
	} catch {
		// Fall through to ps
	}

	// Try ps (macOS / Linux fallback)
	try {
		const result = execSync(`ps -o command= -p ${pid} 2>/dev/null`, {
			encoding: "utf-8",
			timeout: 3000,
		}).trim();
		return result || undefined;
	} catch {
		return undefined;
	}
}

// ── ProcessRegistry ──────────────────────────────────────────────────────────

export class ProcessRegistry {
	private readonly registryPath: string;
	private readonly pruneAgeMs: number;
	private readonly now: () => number;

	/** In-memory index: processName → latest entry */
	private entries: Map<string, ProcessEntry> = new Map();
	private loaded = false;

	constructor(options?: ProcessRegistryOptions) {
		this.registryPath = options?.registryPath ?? join(homedir(), ".mu", "process-registry.jsonl");
		this.pruneAgeMs = options?.pruneAgeMs ?? 24 * 60 * 60 * 1000;
		this.now = options?.now ?? (() => Date.now());
	}

	// ── Persistence ───────────────────────────────────────────────────────

	private async ensureDir(): Promise<void> {
		const dir = join(this.registryPath, "..");
		await mkdir(dir, { recursive: true });
	}

	/** Load entries from JSONL into memory. Idempotent — safe to call multiple times. */
	private async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;

		if (!existsSync(this.registryPath)) return;

		const raw = await readFile(this.registryPath, "utf-8");
		const lines = raw.split("\n");

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as ProcessEntry;
				if (!entry.processName || !entry.type || !entry.pid || !entry.status) continue;
				// Last write wins — later lines overwrite earlier ones for the same processName
				this.entries.set(entry.processName, entry);
			} catch {
				// Skip corrupted lines silently
			}
		}
	}

	/** Append a single entry line to the JSONL file. */
	private async appendLine(entry: ProcessEntry): Promise<void> {
		await this.ensureDir();
		const line = JSON.stringify(entry);
		const current = existsSync(this.registryPath) ? await readFile(this.registryPath, "utf-8") : "";
		const next = current.trimEnd() ? `${current.trimEnd()}\n${line}\n` : `${line}\n`;
		await writeFile(this.registryPath, next, "utf-8");
	}

	/** Rewrite the entire JSONL file from the in-memory index. Used after prune/reconcile batch updates. */
	private async rewriteAll(): Promise<void> {
		await this.ensureDir();
		const lines = Array.from(this.entries.values()).map((e) => JSON.stringify(e));
		await writeFile(this.registryPath, lines.length ? `${lines.join("\n")}\n` : "", "utf-8");
	}

	// ── Public API ────────────────────────────────────────────────────────

	/**
	 * Register a new process. If the name is already taken, a #N suffix is appended.
	 * Returns the created entry with status="running".
	 */
	async register(options: RegisterOptions): Promise<ProcessEntry> {
		await this.load();

		const processName = disambiguateName(new Set(this.entries.keys()), options.name);
		const now = new Date(this.now()).toISOString();

		const entry: ProcessEntry = {
			processName,
			type: options.type,
			pid: options.pid,
			status: "running",
			sessionId: options.sessionId,
			sessionFile: options.sessionFile,
			jobId: options.jobId,
			command: options.command,
			verificationChecks: options.verificationChecks,
			createdAt: now,
			updatedAt: now,
		};

		this.entries.set(processName, entry);
		await this.appendLine(entry);
		return entry;
	}

	/**
	 * Update the status of a registered process.
	 * Throws if the processName is not found.
	 */
	async updateStatus(
		processName: string,
		newStatus: ProcessStatus,
		options?: UpdateStatusOptions,
	): Promise<ProcessEntry> {
		await this.load();

		const existing = this.entries.get(processName);
		if (!existing) {
			throw new Error(`Process not found: ${processName}`);
		}

		const updated: ProcessEntry = {
			...existing,
			status: newStatus,
			exitCode: options?.exitCode ?? existing.exitCode,
			updatedAt: new Date(this.now()).toISOString(),
		};

		this.entries.set(processName, updated);
		await this.appendLine(updated);
		return updated;
	}

	/**
	 * Query registered processes by filters.
	 * All filters are AND-combined. Empty filters return all entries.
	 */
	async query(filters?: QueryFilters): Promise<ProcessEntry[]> {
		await this.load();

		let results = Array.from(this.entries.values());

		if (filters?.name) {
			const pattern = filters.name;
			results = results.filter((e) => {
				if (pattern.includes("*") || pattern.includes("?")) {
					// Simple glob: convert to regex
					const regex = new RegExp(
						`^${pattern
							.replace(/[.+^${}()|[\]\\]/g, "\\$&")
							.replace(/\*/g, ".*")
							.replace(/\?/g, ".")}$`,
					);
					return regex.test(e.processName);
				}
				return e.processName === pattern;
			});
		}

		if (filters?.status) {
			results = results.filter((e) => e.status === filters.status);
		}

		if (filters?.type) {
			results = results.filter((e) => e.type === filters.type);
		}

		return results;
	}

	/**
	 * Get a single process entry by exact name.
	 * Returns undefined if not found.
	 */
	async getByName(processName: string): Promise<ProcessEntry | undefined> {
		await this.load();
		return this.entries.get(processName);
	}

	/**
	 * Reconcile the registry with live OS processes.
	 * - If a PID is dead, mark the entry as "exited".
	 * - If a PID is alive but the command doesn't match (PID recycling), mark as "exited".
	 */
	async reconcile(): Promise<ProcessEntry[]> {
		await this.load();

		const updated: ProcessEntry[] = [];

		for (const [name, entry] of this.entries) {
			if (isTerminalStatus(entry.status)) continue;

			const alive = isPidAlive(entry.pid);
			if (!alive) {
				const updatedEntry: ProcessEntry = {
					...entry,
					status: "exited",
					updatedAt: new Date(this.now()).toISOString(),
				};
				this.entries.set(name, updatedEntry);
				updated.push(updatedEntry);
				continue;
			}

			// PID is alive — check command match to detect PID recycling
			if (entry.command) {
				const currentCommand = getPidCommand(entry.pid);
				if (
					currentCommand !== undefined &&
					!currentCommand.includes(entry.command) &&
					!entry.command.includes(currentCommand)
				) {
					const updatedEntry: ProcessEntry = {
						...entry,
						status: "exited",
						updatedAt: new Date(this.now()).toISOString(),
					};
					this.entries.set(name, updatedEntry);
					updated.push(updatedEntry);
				}
			}
		}

		if (updated.length > 0) {
			await this.rewriteAll();
		}

		return updated;
	}

	/**
	 * Remove terminal entries older than the prune age threshold.
	 * Returns the names of pruned entries.
	 */
	async prune(): Promise<string[]> {
		await this.load();

		const cutoff = this.now() - this.pruneAgeMs;
		const pruned: string[] = [];

		for (const [name, entry] of this.entries) {
			if (!isTerminalStatus(entry.status)) continue;
			const updatedTime = new Date(entry.updatedAt).getTime();
			if (updatedTime < cutoff) {
				this.entries.delete(name);
				pruned.push(name);
			}
		}

		if (pruned.length > 0) {
			await this.rewriteAll();
		}

		return pruned;
	}
}

/**
 * Generate a process name from type and context.
 * Format: `{type}:{slug}` where slug is derived from the context.
 */
export function generateProcessName(type: ProcessType, context: string): string {
	const slug = context
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `${type}:${slug}`;
}
