import { execFile, spawnSync } from "child_process";
import { existsSync, type FSWatcher, readFileSync, statSync, watch } from "fs";
import { dirname, join, resolve } from "path";

type GitPaths = {
	repoDir: string;
	commonGitDir: string;
	headPath: string;
};

/**
 * Find git metadata paths by walking up from cwd.
 * Handles both regular git repos (.git is a directory) and worktrees (.git is a file).
 */
function findGitPaths(): GitPaths | null {
	let dir = process.cwd();
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isFile()) {
					const content = readFileSync(gitPath, "utf8").trim();
					if (content.startsWith("gitdir: ")) {
						const gitDir = resolve(dir, content.slice(8).trim());
						const headPath = join(gitDir, "HEAD");
						if (!existsSync(headPath)) return null;
						const commonDirPath = join(gitDir, "commondir");
						const commonGitDir = existsSync(commonDirPath)
							? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
							: gitDir;
						return { repoDir: dir, commonGitDir, headPath };
					}
				} else if (stat.isDirectory()) {
					const headPath = join(gitPath, "HEAD");
					if (!existsSync(headPath)) return null;
					return { repoDir: dir, commonGitDir: gitPath, headPath };
				}
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

const GIT_SYMBOLIC_REF_ARGS = ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"] as const;

/** Ask git for the current branch (sync, for initial resolution). */
function resolveBranchWithGitSync(repoDir: string): string | null {
	const result = spawnSync("git", GIT_SYMBOLIC_REF_ARGS, {
		cwd: repoDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const branch = result.status === 0 ? result.stdout.trim() : "";
	return branch || null;
}

/** Ask git for the current branch (async, for watcher-triggered refreshes). */
function resolveBranchWithGitAsync(repoDir: string): Promise<string | null> {
	return new Promise((res) => {
		execFile("git", [...GIT_SYMBOLIC_REF_ARGS], { cwd: repoDir, encoding: "utf8" }, (error, stdout) => {
			const branch = !error ? stdout.trim() : "";
			res(branch || null);
		});
	});
}

/** Debounce delay for watcher-triggered branch refreshes (ms). */
const WATCHER_DEBOUNCE_MS = 200;

/**
 * Provides git branch and extension statuses - data not otherwise accessible to extensions.
 * Token stats, model info available via ctx.sessionManager and ctx.model.
 */
export class FooterDataProvider {
	private extensionStatuses = new Map<string, string>();
	private cachedBranch: string | null | undefined = undefined;
	private gitPaths: GitPaths | null | undefined = undefined;
	private headWatcher: FSWatcher | null = null;
	private reftableWatcher: FSWatcher | null = null;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private branchChangeCallbacks = new Set<() => void>();
	private availableProviderCount = 0;

	constructor() {
		this.gitPaths = findGitPaths();
		this.setupGitWatcher();
	}

	/** Current git branch, null if not in repo, "detached" if detached HEAD */
	getGitBranch(): string | null {
		if (this.cachedBranch === undefined) {
			this.cachedBranch = this.resolveGitBranchSync();
		}
		return this.cachedBranch;
	}

	/** Extension status texts set via ctx.ui.setStatus() */
	getExtensionStatuses(): ReadonlyMap<string, string> {
		return this.extensionStatuses;
	}

	/** Subscribe to git branch changes. Returns unsubscribe function. */
	onBranchChange(callback: () => void): () => void {
		this.branchChangeCallbacks.add(callback);
		return () => this.branchChangeCallbacks.delete(callback);
	}

	/** Internal: set extension status */
	setExtensionStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.extensionStatuses.delete(key);
		} else {
			this.extensionStatuses.set(key, text);
		}
	}

	/** Internal: clear extension statuses */
	clearExtensionStatuses(): void {
		this.extensionStatuses.clear();
	}

	/** Number of unique providers with available models (for footer display) */
	getAvailableProviderCount(): number {
		return this.availableProviderCount;
	}

	/** Internal: update available provider count */
	setAvailableProviderCount(count: number): void {
		this.availableProviderCount = count;
	}

	/** Internal: cleanup */
	dispose(): void {
		if (this.headWatcher) {
			this.headWatcher.close();
			this.headWatcher = null;
		}
		if (this.reftableWatcher) {
			this.reftableWatcher.close();
			this.reftableWatcher = null;
		}
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.branchChangeCallbacks.clear();
	}

	private notifyBranchChange(): void {
		for (const cb of this.branchChangeCallbacks) cb();
	}

	/** Schedule a debounced, async branch refresh. Collapses rapid watcher events. */
	private scheduleRefresh(): void {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			this.refreshGitBranchAsync();
		}, WATCHER_DEBOUNCE_MS);
	}

	/** Async branch refresh for watcher events. Avoids blocking the event loop. */
	private async refreshGitBranchAsync(): Promise<void> {
		const nextBranch = await this.resolveGitBranchAsync();
		if (this.cachedBranch !== undefined && this.cachedBranch !== nextBranch) {
			this.cachedBranch = nextBranch;
			this.notifyBranchChange();
			return;
		}
		this.cachedBranch = nextBranch;
	}

	/** Sync branch resolution (used once for the initial getGitBranch() call). */
	private resolveGitBranchSync(): string | null {
		try {
			if (!this.gitPaths) return null;
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			if (content.startsWith("ref: refs/heads/")) {
				const branch = content.slice(16);
				return branch === ".invalid" ? (resolveBranchWithGitSync(this.gitPaths.repoDir) ?? "detached") : branch;
			}
			return "detached";
		} catch {
			return null;
		}
	}

	/** Async branch resolution (used for watcher-triggered refreshes). */
	private async resolveGitBranchAsync(): Promise<string | null> {
		try {
			if (!this.gitPaths) return null;
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			if (content.startsWith("ref: refs/heads/")) {
				const branch = content.slice(16);
				return branch === ".invalid"
					? ((await resolveBranchWithGitAsync(this.gitPaths.repoDir)) ?? "detached")
					: branch;
			}
			return "detached";
		} catch {
			return null;
		}
	}

	private setupGitWatcher(): void {
		if (!this.gitPaths) return;

		// Watch the directory containing HEAD, not HEAD itself.
		// Git uses atomic writes (write temp, rename over HEAD), which changes the inode.
		// fs.watch on a file stops working after the inode changes.
		try {
			this.headWatcher = watch(dirname(this.gitPaths.headPath), (_eventType, filename) => {
				if (!filename || filename.toString() === "HEAD") {
					this.scheduleRefresh();
				}
			});
		} catch {
			// Silently fail if we can't watch
		}

		// In reftable repos, branch switches update files in the reftable directory
		// instead of HEAD. Watch it separately so the footer picks up those changes.
		const reftableDir = join(this.gitPaths.commonGitDir, "reftable");
		if (existsSync(reftableDir)) {
			try {
				this.reftableWatcher = watch(reftableDir, () => {
					this.scheduleRefresh();
				});
			} catch {
				// Silently fail if we can't watch
			}
		}
	}
}

/** Read-only view for extensions - excludes setExtensionStatus, setAvailableProviderCount and dispose */
export type ReadonlyFooterDataProvider = Pick<
	FooterDataProvider,
	"getGitBranch" | "getExtensionStatuses" | "getAvailableProviderCount" | "onBranchChange"
>;
