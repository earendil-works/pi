import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Workspace } from "../../plugins/workspace/environment.ts";

const context = BACKGROUND_CONTEXT;

test("search without git grep -m keeps per-file limits and propagates other errors", async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "p2-workspace-grep-")));
	try {
		await writeFile(join(directory, "many.txt"), "needle\n".repeat(25));
		await writeFile(join(directory, "other.txt"), "needle\n");
		for (const repo of [false, true]) {
			if (repo) execFileSync("git", ["init", "-q"], { cwd: directory });
			const env = new NodeExecutionEnv({ cwd: directory });
			const exec = env.exec.bind(env);
			let rejected = 0;
			let fail = false;
			env.exec = async (argv, options, executing) => {
				if (typeof argv !== "string" && argv.includes("grep") && (fail || argv.includes("-m"))) {
					rejected++;
					options?.onOutput?.(fail ? "fatal: fixture failure\n" : "error: unknown switch `m'\n", executing, {
						stream: "stderr",
					});
					return { ok: true, value: { exitCode: 129 } };
				}
				return exec(argv, options, executing);
			};
			const workspace = new Workspace(env);
			const result = await workspace.query({ kind: "search", path: "", text: "needle" }, context);
			assert(result.kind === "search");
			assert.equal(rejected, 1);
			assert.equal(result.matches.filter((match) => match.path === "many.txt").length, 20);
			assert.equal(result.matches.filter((match) => match.path === "other.txt").length, 1);
			assert.equal(result.truncated, false);
			fail = true;
			await assert.rejects(
				workspace.query({ kind: "search", path: "", text: "needle" }, context),
				/fixture failure/,
			);
			assert.equal(rejected, 2, "unrelated failures are not retried");
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

// Pi Mobile 24e3fccdd: a subagent's own cwd may be a linked worktree, whose index and HEAD live in the main repository.
test("a linked git worktree's index and HEAD are watched", { timeout: 60_000 }, async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "p2-workspace-worktree-")));
	const git = (cwd: string, ...args: string[]) =>
		execFileSync(
			"git",
			["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
			{ cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } },
		);
	try {
		const root = join(directory, "repo");
		const linked = join(directory, "linked");
		await mkdir(root);
		git(root, "init", "-q");
		await writeFile(join(root, "a.txt"), "a\n");
		git(root, "add", "a.txt");
		git(root, "commit", "-q", "-m", "init");
		git(root, "worktree", "add", "-q", "-b", "side", linked);
		const workspace = new Workspace(new NodeExecutionEnv({ cwd: linked }));
		await writeFile(join(linked, "new.txt"), "x\n");
		let changes = 0;
		const watcher = await workspace.watch(() => changes++, context);
		assert(watcher);
		try {
			// Staging changes only the worktree's index, in the main repository's git directory.
			git(linked, "add", "new.txt");
			for (let i = 0; i < 100 && !changes; i++) await new Promise((done) => setTimeout(done, 100));
			assert(changes > 0, "index change reported");
		} finally {
			await watcher.stop(context);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test(
	"the watch covers the root recursively, and a large tree watches its root only",
	{
		timeout: 60_000,
	},
	async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "p2-workspace-watch-")));
		const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));
		const until = async (check: () => boolean) => {
			for (let i = 0; i < 100 && !check(); i++) await settle(100);
			return check();
		};
		try {
			const root = join(directory, "small");
			await mkdir(join(root, "a/b"), { recursive: true });
			await mkdir(join(root, "home/other"), { recursive: true });
			const workspace = new Workspace(new NodeExecutionEnv({ cwd: root }));
			let changes = 0;
			const watcher = await workspace.watch(() => changes++, context);
			assert(watcher);
			try {
				await writeFile(join(root, "home/other/file"), "x\n");
				assert(await until(() => changes > 0), "a nested folder is watched");
				changes = 0;
				await writeFile(join(root, "a/b/file"), "x\n");
				assert(await until(() => changes > 0), "other folders are watched recursively");
			} finally {
				await watcher.stop(context);
			}

			const large = join(directory, "large");
			for (let index = 0; index <= 2000; index++) await mkdir(join(large, `d${index}`), { recursive: true });
			const big = new Workspace(new NodeExecutionEnv({ cwd: large }));
			let bigChanges = 0;
			const bigWatcher = await big.watch(() => bigChanges++, context);
			assert(bigWatcher);
			try {
				await writeFile(join(large, "d5/file"), "x\n");
				await settle(1000);
				assert.equal(bigChanges, 0, "below the root of a large tree nothing is watched");
				await writeFile(join(large, "top.txt"), "x\n");
				assert(await until(() => bigChanges > 0), "the root's entries are watched");
			} finally {
				await bigWatcher.stop(context);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("a root inside a repository lists changes and commits relative to itself, and opens them", async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "p2-workspace-subdir-")));
	const git = (...args: string[]) =>
		execFileSync(
			"git",
			["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
			{ cwd: directory, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } },
		).toString();
	try {
		await mkdir(join(directory, "apps/web"), { recursive: true });
		await writeFile(join(directory, "apps/web/a.txt"), "before\n");
		await writeFile(join(directory, "outside.txt"), "before\n");
		git("init", "-q");
		git("add", ".");
		git("commit", "-q", "-m", "init");
		await writeFile(join(directory, "apps/web/a.txt"), "after\n");
		await writeFile(join(directory, "apps/web/new.txt"), "new\n");
		await writeFile(join(directory, "outside.txt"), "after\n");
		const workspace = new Workspace(new NodeExecutionEnv({ cwd: join(directory, "apps/web") }));
		const status = await workspace.query({ kind: "status" }, context);
		assert(status.kind === "status" && status.repo);
		assert.deepEqual(status.changes.map((change) => change.path).sort(), ["a.txt", "new.txt"]);
		const diff = await workspace.query({ kind: "diff", path: "a.txt" }, context);
		assert(diff.kind === "diff" && diff.patch.includes("+after"));
		const file = await workspace.query({ kind: "file", path: "a.txt" }, context);
		assert(file.kind === "file" && file.text === "after\n");
		const hash = git("rev-parse", "HEAD").trim();
		const commit = await workspace.query({ kind: "commit", commit: hash }, context);
		assert(commit.kind === "commit");
		assert.deepEqual(
			commit.changes.map((change) => change.path),
			["a.txt"],
		);
		const old = await workspace.query({ kind: "file", path: "a.txt", commit: hash }, context);
		assert(old.kind === "file" && old.text === "before\n");
		const commitDiff = await workspace.query({ kind: "diff", path: "a.txt", commit: hash }, context);
		assert(commitDiff.kind === "diff" && commitDiff.patch.includes("+before"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
