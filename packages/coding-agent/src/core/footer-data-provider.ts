import { type ExecFileException, execFile, spawnSync } from "child_process";
import { existsSync, type FSWatcher, readFileSync, statSync, unwatchFile, watchFile } from "fs";
import { dirname, join, resolve } from "path";
import { closeWatcher, FS_WATCH_RETRY_DELAY_MS, watchWithErrorHandler } from "../utils/fs-watch.ts";

type GitPaths = {
	repoDir: string;
	commonGitDir: string;
	headPath: string;
};

/**
 * Find git metadata paths by walking up from cwd.
 * Handles both regular git repos (.git is a directory) and worktrees (.git is a file).
 */
function findGitPaths(cwd: string): GitPaths | null {
	let dir = cwd;
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

/** Ask git for the current branch synchronously. Returns null on detached HEAD or if git is unavailable. */
function resolveBranchWithGitSync(repoDir: string): string | null {
	const result = spawnSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
		cwd: repoDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const branch = result.status === 0 ? result.stdout.trim() : "";
	return branch || null;
}

/** Ask git for the current branch asynchronously. Returns null on detached HEAD or if git is unavailable. */
function resolveBranchWithGitAsync(repoDir: string): Promise<string | null> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
			{
				cwd: repoDir,
				encoding: "utf8",
			},
			(error: ExecFileException | null, stdout: string) => {
				if (error) {
					resolvePromise(null);
					return;
				}
				const branch = stdout.trim();
				resolvePromise(branch || null);
			},
		);
	});
}

/**
 * A VCS provider registered by an extension or built-in.
 * Providers are tried in registration order; the first non-null detect() result wins.
 * The built-in git provider runs last.
 */
export interface VcsProvider {
	/** Unique name, e.g. "git", "jj" */
	name: string;
	/** Return a display string for the VCS state at `dir`, or null if this provider doesn't apply. */
	detect(dir: string): string | null;
	/** Optional async detection for watch-triggered refreshes. Falls back to detect() if not provided. */
	detectAsync?(dir: string): Promise<string | null>;
	/** Optional: start watching for changes. Returns a dispose function. */
	watch?(dir: string, onChange: () => void): { dispose(): void };
}

/**
 * Provides VCS branch info and extension statuses - data not otherwise accessible to extensions.
 * Token stats, model info available via ctx.sessionManager and ctx.model.
 */
export class FooterDataProvider {
	private cwd: string;
	private static readonly WATCH_DEBOUNCE_MS = 500;

	private extensionStatuses = new Map<string, string>();
	private cachedBranch: string | null | undefined = undefined;
	private gitPaths: GitPaths | null | undefined = undefined;
	private headWatcher: FSWatcher | null = null;
	private reftableWatcher: FSWatcher | null = null;
	private reftableTablesListWatcher: FSWatcher | null = null;
	private reftableTablesListPath: string | null = null;
	private branchChangeCallbacks = new Set<() => void>();
	private availableProviderCount = 0;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private gitWatcherRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshInFlight = false;
	private refreshPending = false;
	private disposed = false;
	private customProviders: VcsProvider[] = [];
	private customProviderWatches: Array<{ dispose(): void }> = [];

	constructor(cwd: string) {
		this.cwd = cwd;
		this.gitPaths = findGitPaths(cwd);
		this.setupGitWatcher();
	}

	/** Register a VCS provider. Custom providers are tried before the built-in git provider. */
	registerVcsProvider(provider: VcsProvider): void {
		this.customProviders.push(provider);
		this.cachedBranch = undefined;
		this.setupCustomProviderWatches();
		this.notifyBranchChange();
	}

	/** Unregister a previously registered VCS provider by name. */
	unregisterVcsProvider(name: string): void {
		const idx = this.customProviders.findIndex((p) => p.name === name);
		if (idx < 0) return;
		this.customProviders.splice(idx, 1);
		this.cachedBranch = undefined;
		this.setupCustomProviderWatches();
		this.notifyBranchChange();
	}

	/** Current VCS display string, null if no VCS detected. May be branch name, change ID, "detached", etc. */
	getVcsMessage(): string | null {
		if (this.cachedBranch === undefined) {
			this.cachedBranch = this.resolveBranchSync();
		}
		return this.cachedBranch;
	}

	/** Extension status texts set via ctx.ui.setStatus() */
	getExtensionStatuses(): ReadonlyMap<string, string> {
		return this.extensionStatuses;
	}

	/** Subscribe to VCS branch changes. Returns unsubscribe function. */
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

	setCwd(cwd: string): void {
		if (this.cwd === cwd) {
			return;
		}

		this.cwd = cwd;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.clearGitWatchers();
		this.clearCustomProviderWatches();
		this.cachedBranch = undefined;
		this.gitPaths = findGitPaths(cwd);
		this.setupGitWatcher();
		this.setupCustomProviderWatches();
		this.notifyBranchChange();
	}

	/** Internal: cleanup */
	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.clearGitWatchers();
		this.clearCustomProviderWatches();
		this.branchChangeCallbacks.clear();
	}

	private notifyBranchChange(): void {
		for (const cb of this.branchChangeCallbacks) cb();
	}

	private scheduleRefresh(): void {
		if (this.disposed || this.refreshTimer) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void this.refreshBranchAsync();
		}, FooterDataProvider.WATCH_DEBOUNCE_MS);
	}

	private async refreshBranchAsync(): Promise<void> {
		if (this.disposed) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}

		this.refreshInFlight = true;
		try {
			const nextBranch = await this.resolveBranchAsync();
			if (this.disposed) return;
			if (this.cachedBranch !== undefined && this.cachedBranch !== nextBranch) {
				this.cachedBranch = nextBranch;
				this.notifyBranchChange();
				return;
			}
			this.cachedBranch = nextBranch;
		} finally {
			this.refreshInFlight = false;
			if (this.refreshPending && !this.disposed) {
				this.refreshPending = false;
				this.scheduleRefresh();
			}
		}
	}

	private async resolveBranchAsync(): Promise<string | null> {
		for (const provider of this.customProviders) {
			try {
				const result = provider.detectAsync ? await provider.detectAsync(this.cwd) : provider.detect(this.cwd);
				if (result !== null) return result;
			} catch {
				// ignore errors from custom providers
			}
		}
		return this.resolveGitBranchAsync();
	}

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

	private resolveBranchSync(): string | null {
		for (const provider of this.customProviders) {
			try {
				const result = provider.detect(this.cwd);
				if (result !== null) return result;
			} catch {
				// ignore errors from custom providers
			}
		}
		return this.resolveGitBranchSync();
	}

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

	private clearGitWatchers(): void {
		closeWatcher(this.headWatcher);
		this.headWatcher = null;
		closeWatcher(this.reftableWatcher);
		this.reftableWatcher = null;
		closeWatcher(this.reftableTablesListWatcher);
		this.reftableTablesListWatcher = null;
		if (this.reftableTablesListPath) {
			unwatchFile(this.reftableTablesListPath);
			this.reftableTablesListPath = null;
		}
		if (this.gitWatcherRetryTimer) {
			clearTimeout(this.gitWatcherRetryTimer);
			this.gitWatcherRetryTimer = null;
		}
	}

	private scheduleGitWatcherRetry(): void {
		if (this.disposed || this.gitWatcherRetryTimer) {
			return;
		}

		this.gitWatcherRetryTimer = setTimeout(() => {
			this.gitWatcherRetryTimer = null;
			this.setupGitWatcher();
		}, FS_WATCH_RETRY_DELAY_MS);
	}

	private clearCustomProviderWatches(): void {
		for (const watch of this.customProviderWatches) {
			try {
				watch.dispose();
			} catch {
				// ignore errors during cleanup
			}
		}
		this.customProviderWatches = [];
	}

	private setupCustomProviderWatches(): void {
		this.clearCustomProviderWatches();
		for (const provider of this.customProviders) {
			if (!provider.watch) continue;
			try {
				const watch = provider.watch(this.cwd, () => this.scheduleRefresh());
				this.customProviderWatches.push(watch);
			} catch {
				// ignore errors from custom watch setup
			}
		}
	}

	private handleGitWatcherError(): void {
		this.clearGitWatchers();
		this.scheduleGitWatcherRetry();
	}

	private setupGitWatcher(): void {
		this.clearGitWatchers();
		if (!this.gitPaths) return;

		// Watch the directory containing HEAD, not HEAD itself.
		// Git uses atomic writes (write temp, rename over HEAD), which changes the inode.
		// fs.watch on a file stops working after the inode changes.
		this.headWatcher = watchWithErrorHandler(
			dirname(this.gitPaths.headPath),
			(_eventType, filename) => {
				if (!filename || filename === "HEAD") {
					this.scheduleRefresh();
				}
			},
			() => this.handleGitWatcherError(),
		);
		if (!this.headWatcher) {
			return;
		}

		// In reftable repos, branch switches update files in the reftable directory
		// instead of HEAD. Watch it separately so the footer picks up those changes.
		const reftableDir = join(this.gitPaths.commonGitDir, "reftable");
		if (existsSync(reftableDir)) {
			this.reftableWatcher = watchWithErrorHandler(
				reftableDir,
				() => {
					this.scheduleRefresh();
				},
				() => this.handleGitWatcherError(),
			);
			if (!this.reftableWatcher) {
				return;
			}

			const tablesListPath = join(reftableDir, "tables.list");
			if (existsSync(tablesListPath)) {
				this.reftableTablesListPath = tablesListPath;
				this.reftableTablesListWatcher = watchWithErrorHandler(
					tablesListPath,
					() => {
						this.scheduleRefresh();
					},
					() => this.handleGitWatcherError(),
				);
				if (!this.reftableTablesListWatcher) {
					return;
				}
				watchFile(tablesListPath, { interval: 250 }, (current, previous) => {
					if (
						current.mtimeMs !== previous.mtimeMs ||
						current.ctimeMs !== previous.ctimeMs ||
						current.size !== previous.size
					) {
						this.scheduleRefresh();
					}
				});
			}
		}
	}
}

/** Read-only view for extensions - excludes setExtensionStatus, setAvailableProviderCount and dispose */
export type ReadonlyFooterDataProvider = Pick<
	FooterDataProvider,
	"getVcsMessage" | "getExtensionStatuses" | "getAvailableProviderCount" | "onBranchChange"
>;
