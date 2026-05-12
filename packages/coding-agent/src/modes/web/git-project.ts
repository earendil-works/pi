import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./http.js";
import type { Broadcast, GitChangedLines, GitProjectStatus } from "./types.js";

const execFileAsync = promisify(execFile);

interface CommandResult {
	stdout: string;
	stderr: string;
}

interface CheckpointInfo {
	at: string;
	ref: string;
}

export class GitProjectManager {
	private readonly checkpoints = new Map<string, CheckpointInfo>();

	constructor(private readonly broadcast: Broadcast) {}

	async status(cwd: string): Promise<GitProjectStatus> {
		const resolvedCwd = path.resolve(cwd);
		const ghLoggedIn = await this.ghLoggedIn(resolvedCwd);
		const base = (error: string | null = null): GitProjectStatus => ({
			cwd: resolvedCwd,
			isRepo: false,
			branch: null,
			upstream: null,
			hasRemote: false,
			ghLoggedIn,
			githubReady: false,
			changedLines: { added: 0, deleted: 0, total: 0 },
			...this.checkpointFields(resolvedCwd),
			error,
		});
		try {
			await this.git(resolvedCwd, ["rev-parse", "--is-inside-work-tree"]);
		} catch {
			return base(null);
		}
		try {
			const branch = (await this.git(resolvedCwd, ["branch", "--show-current"])).stdout.trim() || null;
			const upstream = await this.gitOptional(resolvedCwd, [
				"rev-parse",
				"--abbrev-ref",
				"--symbolic-full-name",
				"@{u}",
			]);
			const remote = await this.gitOptional(resolvedCwd, ["remote", "get-url", "origin"]);
			const githubReady = ghLoggedIn && (await this.commandOk("gh", ["repo", "view"], resolvedCwd));
			const changedLines = await this.changedLines(resolvedCwd, upstream);
			return {
				cwd: resolvedCwd,
				isRepo: true,
				branch,
				upstream,
				hasRemote: !!remote,
				ghLoggedIn,
				githubReady,
				changedLines,
				...this.checkpointFields(resolvedCwd),
				error: null,
			};
		} catch (error) {
			return base(error instanceof Error ? error.message : String(error));
		}
	}

	async checkpoint(cwd: string, sessionFile: string | null): Promise<GitProjectStatus> {
		const status = await this.status(cwd);
		if (!status.isRepo) {
			this.broadcast({ type: "git_status", data: status });
			return status;
		}
		const ref = checkpointRef(sessionFile || status.cwd);
		const indexPath = path.join(
			os.tmpdir(),
			`pi-web-index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		);
		const env = {
			GIT_INDEX_FILE: indexPath,
			GIT_AUTHOR_NAME: "Pi Web",
			GIT_AUTHOR_EMAIL: "pi-web@local",
			GIT_COMMITTER_NAME: "Pi Web",
			GIT_COMMITTER_EMAIL: "pi-web@local",
		};
		try {
			const head = await this.gitOptional(status.cwd, ["rev-parse", "--verify", "HEAD"]);
			if (head) await this.git(status.cwd, ["read-tree", "HEAD"], env);
			else await this.git(status.cwd, ["read-tree", "--empty"], env);
			await this.git(status.cwd, ["add", "-A", "--", "."], env);
			const tree = (await this.git(status.cwd, ["write-tree"], env)).stdout.trim();
			const parent = (await this.gitOptional(status.cwd, ["rev-parse", "--verify", ref])) || head;
			const args = ["commit-tree", tree, "-m", "Pi web checkpoint"];
			if (parent) args.splice(2, 0, "-p", parent);
			const commit = (await this.git(status.cwd, args, env)).stdout.trim();
			await this.git(status.cwd, ["update-ref", ref, commit]);
			this.checkpoints.set(status.cwd, { at: new Date().toISOString(), ref });
		} finally {
			await fs.rm(indexPath, { force: true });
		}
		const next = await this.status(status.cwd);
		this.broadcast({ type: "git_checkpoint", data: next });
		return next;
	}

	async commit(cwd: string, message: string): Promise<GitProjectStatus> {
		const commitMessage = String(message || "").trim();
		if (!commitMessage) throw new HttpError(400, "Missing commit message");
		const status = await this.status(cwd);
		if (!status.isRepo) throw new HttpError(400, "Project is not a git repository");
		await this.git(status.cwd, ["add", "-A", "--", "."]);
		const hasChanges = !(await this.commandOk("git", ["diff", "--cached", "--quiet"], status.cwd));
		if (!hasChanges) throw new HttpError(400, "No changes to commit");
		await this.git(status.cwd, ["commit", "-m", commitMessage]);
		return this.broadcastStatus(status.cwd);
	}

	async push(cwd: string): Promise<GitProjectStatus> {
		const status = await this.status(cwd);
		if (!status.isRepo) throw new HttpError(400, "Project is not a git repository");
		if (!status.hasRemote) throw new HttpError(400, "No origin remote configured");
		if (!status.branch) throw new HttpError(400, "Cannot push detached HEAD");
		if (status.upstream) await this.git(status.cwd, ["push"]);
		else await this.git(status.cwd, ["push", "-u", "origin", status.branch]);
		return this.broadcastStatus(status.cwd);
	}

	async init(cwd: string): Promise<GitProjectStatus> {
		const resolvedCwd = path.resolve(cwd);
		await this.git(resolvedCwd, ["init"]);
		return this.broadcastStatus(resolvedCwd);
	}

	async createGithubRepo(cwd: string): Promise<GitProjectStatus> {
		const status = await this.status(cwd);
		if (!status.isRepo) await this.git(status.cwd, ["init"]);
		await this.command("gh", ["repo", "create", "--private", "--source", ".", "--remote", "origin"], status.cwd);
		return this.broadcastStatus(status.cwd);
	}

	async broadcastStatus(cwd: string): Promise<GitProjectStatus> {
		const status = await this.status(cwd);
		this.broadcast({ type: "git_status", data: status });
		return status;
	}

	private async changedLines(cwd: string, upstream: string | null): Promise<GitChangedLines> {
		const base = upstream || (await this.gitOptional(cwd, ["rev-parse", "--verify", "HEAD"]));
		const tracked = base
			? parseNumstat((await this.git(cwd, ["diff", "--numstat", base])).stdout)
			: { added: 0, deleted: 0, total: 0 };
		const untracked = await this.untrackedLines(cwd);
		return {
			added: tracked.added + untracked,
			deleted: tracked.deleted,
			total: tracked.total + untracked,
		};
	}

	private async untrackedLines(cwd: string): Promise<number> {
		const output = (await this.git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout;
		const files = output.split("\0").filter(Boolean);
		let lines = 0;
		for (const file of files) {
			const fullPath = path.join(cwd, file);
			const stat = await fs.stat(fullPath).catch(() => null);
			if (!stat?.isFile() || stat.size > 1024 * 1024) continue;
			const data = await fs.readFile(fullPath).catch(() => null);
			if (!data || data.includes(0)) continue;
			lines += data.toString("utf8").split(/\r?\n/).length;
		}
		return lines;
	}

	private checkpointFields(cwd: string): Pick<GitProjectStatus, "lastCheckpointAt" | "lastCheckpointRef"> {
		const checkpoint = this.checkpoints.get(cwd);
		return {
			lastCheckpointAt: checkpoint?.at || null,
			lastCheckpointRef: checkpoint?.ref || null,
		};
	}

	private async ghLoggedIn(cwd: string): Promise<boolean> {
		return this.commandOk("gh", ["auth", "status"], cwd);
	}

	private async gitOptional(cwd: string, args: string[]): Promise<string | null> {
		try {
			return (await this.git(cwd, args)).stdout.trim() || null;
		} catch {
			return null;
		}
	}

	private git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<CommandResult> {
		return this.command("git", args, cwd, env);
	}

	private async commandOk(file: string, args: string[], cwd: string): Promise<boolean> {
		try {
			await this.command(file, args, cwd);
			return true;
		} catch {
			return false;
		}
	}

	private async command(
		file: string,
		args: string[],
		cwd: string,
		env: Record<string, string> = {},
	): Promise<CommandResult> {
		try {
			const result = await execFileAsync(file, args, {
				cwd,
				env: { ...process.env, ...env },
				maxBuffer: 10 * 1024 * 1024,
				timeout: 120000,
			});
			return { stdout: result.stdout, stderr: result.stderr };
		} catch (error) {
			const detail = error as { stderr?: string; stdout?: string; message?: string };
			throw new Error(String(detail.stderr || detail.stdout || detail.message || error).trim());
		}
	}
}

export function parseNumstat(output: string): GitChangedLines {
	let added = 0;
	let deleted = 0;
	for (const line of output.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const [rawAdded, rawDeleted] = line.split(/\s+/);
		const nextAdded = Number(rawAdded);
		const nextDeleted = Number(rawDeleted);
		if (Number.isFinite(nextAdded)) added += nextAdded;
		if (Number.isFinite(nextDeleted)) deleted += nextDeleted;
	}
	return { added, deleted, total: added + deleted };
}

function checkpointRef(value: string): string {
	const id = Buffer.from(value).toString("base64url").slice(0, 80) || "default";
	return `refs/pi-web/checkpoints/${id}`;
}
