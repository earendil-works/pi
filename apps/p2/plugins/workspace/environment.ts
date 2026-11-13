import type {
	ExecutionEnv,
	FileError,
	FileInfo,
	FileWatcher,
	Result,
	WatchTarget,
} from "@earendil-works/pi-durable/env";
import type { Context } from "@p2/app/v1";
import { withCancel } from "@p2/app/v1";
import {
	WORKSPACE_READ_CHUNK,
	WORKSPACE_TEXT_LIMIT,
	type WorkspaceBytes,
	type WorkspaceChange,
	type WorkspaceCommit,
	type WorkspaceEntry,
	type WorkspaceMatch,
	type WorkspaceQuery,
	type WorkspaceResult,
	type WorkspaceUpload,
	workspaceGlobs,
	workspacePath,
} from "./protocol.ts";

const LIST_LIMIT = 2000;
const STATUS_LIMIT = 5000;
const STATUS_BYTES = 1024 * 1024;
const DIFF_BYTES = 512 * 1024;
const UNTRACKED_BYTES = 256 * 1024;
const GIT_TIMEOUT = 10_000;
const SEARCH_BYTES = 256 * 1024;
const SEARCH_LIMIT = 500;
const LOG_BYTES = 512 * 1024;
const FILES_LIMIT = 50_000;
const FILES_BYTES = 4 * 1024 * 1024;
const WALK_DIRECTORIES = 5000;
/** Entries the walk reads from one directory; beyond it the directory is cut in its own (unsorted) order. */
const WALK_DIRECTORY_ENTRIES = 2 * FILES_LIMIT;
/**
 * Most directories the working tree's watch covers. Every change rescans the whole watched tree (and on Linux each
 * directory is one watch), so a larger tree, such as a home folder, gets only its root's own entries watched.
 */
const WATCH_DIRECTORIES = 2000;
/** Folders the working tree's watch skips at any depth. */
const WATCH_EXCLUDED = [".git", "node_modules"];

// Read-only, bounded views of one execution environment's working directory. Every
// file operation and git command goes through the environment, never this process's
// filesystem, so a remote environment works unchanged. Canonical confinement filters
// accidental escapes (symlinked directories); it is not a security boundary against
// a hostile environment, which owners and read/write guests can already command.
export class Workspace {
	readonly env: ExecutionEnv;
	private root?: string;

	constructor(env: ExecutionEnv) {
		this.env = env;
	}

	private async canonicalRoot(context: Context): Promise<string> {
		if (this.root) return this.root;
		const result = await this.env.canonicalPath(this.env.cwd, context);
		if (!result.ok) throw new Error(`Working directory unavailable: ${result.error.code}`);
		this.root = result.value.replace(/\/+$/, "") || "/";
		return this.root;
	}

	/** Absolute environment path of a validated relative path, confined to the root. */
	private async resolve(path: string, context: Context): Promise<string> {
		const absolute = await this.absolute(path, context);
		await this.confine(absolute, context);
		return absolute;
	}

	/** The absolute environment path of a validated relative path, not yet checked to stay inside the root. */
	private async absolute(path: string, context: Context): Promise<string> {
		const relative = workspacePath(path);
		if (relative === undefined) throw new Error("Invalid workspace path");
		const root = await this.canonicalRoot(context);
		return relative ? `${root === "/" ? "" : root}/${relative}` : root;
	}

	/**
	 * Open `path` while checking that it stays inside the root, in parallel: a remote environment pays one round trip for
	 * both. Nothing opened is used before the check passed; an opened handle of a refused path is closed.
	 */
	private async openConfined<T extends { close(context: Context): Promise<void> }>(
		path: string,
		open: (absolute: string) => Promise<Result<T, FileError>>,
		context: Context,
	): Promise<{ absolute: string; opened: Result<T, FileError> }> {
		const absolute = await this.absolute(path, context);
		const [confined, opened] = await Promise.allSettled([this.confine(absolute, context), open(absolute)]);
		if (confined.status === "rejected") {
			if (opened.status === "fulfilled" && opened.value.ok) void opened.value.value.close(context);
			throw confined.reason;
		}
		if (opened.status === "rejected") throw opened.reason;
		return { absolute, opened: opened.value };
	}

	private async confine(absolute: string, context: Context): Promise<void> {
		const root = await this.canonicalRoot(context);
		const canonical = await this.env.canonicalPath(absolute, context);
		if (!canonical.ok) throw new Error(canonical.error.code === "not_found" ? "File not found" : "Cannot open path");
		const inside = (base: string, value: string) =>
			value === base || value.startsWith(base === "/" ? "/" : `${base}/`);
		if (!inside(root, canonical.value)) throw new Error("Path leaves the working directory");
	}

	/** Every query but `place`, which the worker answers (where it opened this workspace). */
	async query(query: Exclude<WorkspaceQuery, { kind: "place" }>, context: Context): Promise<WorkspaceResult> {
		switch (query.kind) {
			case "list":
				return this.list(query.path, context);
			case "file":
				return query.commit ? this.fileAt(query.commit, query.path, context) : this.file(query.path, context);
			case "log":
				return this.log(query.skip, query.limit, context);
			case "commit":
				return this.commit(query.commit, context);
			case "status":
				return this.status(context);
			case "files":
				return this.files(context);
			case "search":
				return this.search(query, context);
			case "diff":
				return query.commit
					? this.commitDiff(query.commit, query.path, query.full === true, context, query.context)
					: this.diff(query.path, query.full === true, context, query.context);
		}
	}

	private async list(path: string, context: Context): Promise<WorkspaceResult> {
		// Git's filter overrides are needed for check-ignore below: fetch them while the folder is read.
		const filters = this.filterOverrides(context);
		filters.catch(() => {});
		const { absolute, opened } = await this.openConfined(
			path,
			(directory) => this.env.openDirReader(directory, context),
			context,
		);
		if (!opened.ok)
			throw new Error(opened.error.code === "not_directory" ? "Not a directory" : "Cannot list directory");
		const entries: WorkspaceEntry[] = [];
		let truncated = false;
		try {
			for (;;) {
				const page = await opened.value.next(Math.min(500, LIST_LIMIT + 1 - entries.length), context);
				if (!page.ok) throw new Error("Cannot list directory");
				for (const entry of page.value.entries) {
					if (!path && entry.name === ".git") continue;
					entries.push({ name: entry.name, kind: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs });
				}
				if (entries.length > LIST_LIMIT) {
					truncated = true;
					entries.length = LIST_LIMIT;
					break;
				}
				if (page.value.done) break;
			}
		} finally {
			// Nothing waits for the close: it costs a remote environment a round trip.
			void opened.value.close(context);
		}
		entries.sort(
			(a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name),
		);
		// Ignored entries, by .gitignore; tracked files and non-repositories report none. Run from this directory, in
		// batches of at most 24,000 characters (Windows limits a command line to 32,767) started together: one round
		// trip for any directory. Names containing newlines remain unannotated because output is line-based.
		const batches: string[][] = [];
		let length = 0;
		for (const entry of entries) {
			if (entry.name.includes("\n")) continue;
			const last = batches.at(-1);
			if (!last || length + entry.name.length + 3 > 24_000) {
				batches.push([entry.name]);
				length = entry.name.length + 3;
			} else {
				last.push(entry.name);
				length += entry.name.length + 3;
			}
		}
		const runs = await Promise.all(
			batches.map((names) =>
				this.git(["check-ignore", "--", ...names], STATUS_BYTES, context, filters, absolute).catch(() => undefined),
			),
		);
		const ignored = new Set(
			runs.flatMap((run) => (run && run.exitCode <= 1 ? run.stdout.split("\n").filter(Boolean) : [])),
		);
		for (const entry of entries) if (ignored.has(entry.name)) entry.ignored = true;
		return { kind: "list", path, entries, truncated };
	}

	private async file(path: string, context: Context): Promise<WorkspaceResult> {
		const { opened } = await this.openConfined(
			path,
			(absolute) => this.env.openBinaryReader(absolute, { noFollow: true }, context),
			context,
		);
		if (!opened.ok) throw new Error(opened.error.code === "is_directory" ? "Is a directory" : "Not a regular file");
		try {
			// Size and content together: the read stops at the limit or the end of the file either way.
			const [info, read] = await Promise.all([
				opened.value.info(context),
				opened.value.read(0, WORKSPACE_TEXT_LIMIT, context),
			]);
			if (!info.ok || !read.ok) throw new Error("Cannot read file");
			const size = info.value.size;
			const truncated = size > WORKSPACE_TEXT_LIMIT;
			const text = decodeText(read.value, truncated);
			return text === undefined
				? { kind: "file", path, size, binary: true, truncated }
				: { kind: "file", path, size, binary: false, text, truncated };
		} finally {
			void opened.value.close(context);
		}
	}

	/** Up to one chunk of bytes. `end` is inclusive; `suffix` reads the last bytes. */
	async read(
		path: string,
		range: { start?: number; end?: number; suffix?: number },
		context: Context,
	): Promise<WorkspaceBytes> {
		const { opened } = await this.openConfined(
			path,
			(absolute) => this.env.openBinaryReader(absolute, { noFollow: true }, context),
			context,
		);
		if (!opened.ok) throw new Error("Not a regular file");
		try {
			// A range from a known start is read together with the size; a suffix needs the size first.
			const known = range.suffix === undefined ? (range.start ?? 0) : undefined;
			const ahead =
				known === undefined
					? undefined
					: opened.value.read(
							known,
							Math.min(
								range.end === undefined ? Number.MAX_SAFE_INTEGER : range.end - known + 1,
								WORKSPACE_READ_CHUNK,
							),
							context,
						);
			ahead?.catch(() => {});
			const info = await opened.value.info(context);
			if (!info.ok) throw new Error("Cannot read file");
			const size = info.value.size;
			const start = range.suffix !== undefined ? Math.max(0, size - range.suffix) : (range.start ?? 0);
			const end = Math.min(range.end ?? size - 1, size - 1, start + WORKSPACE_READ_CHUNK - 1);
			if (start >= size || end < start) return { size, start, data: "" };
			const read = ahead ? await ahead : await opened.value.read(start, end - start + 1, context);
			if (!read.ok) throw new Error("Cannot read file");
			// The file may have grown since its size was read: serve the announced range only.
			return { size, start, data: Buffer.from(read.value.subarray(0, end - start + 1)).toString("base64") };
		} finally {
			void opened.value.close(context);
		}
	}

	/**
	 * Changes below the root, with paths relative to it: git reports them relative to the repository's top level, which
	 * is above the root when the root is a folder inside a repository (`~/repo/apps/web`).
	 */
	private async status(context: Context): Promise<WorkspaceResult> {
		const located = await this.git(["rev-parse", "--show-prefix"], 8192, context);
		const prefix = located.exitCode === 0 ? located.stdout.trim() : "";
		const below = (path: string) => (prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path);
		const run = await this.git(
			[
				"status",
				"--porcelain=v2",
				"-z",
				"--branch",
				// List files inside new folders; `normal` reports only the folder, which has no diff.
				"--untracked-files=all",
				"--ignore-submodules=dirty",
				"--no-ahead-behind",
				"--",
				".",
			],
			STATUS_BYTES,
			context,
		);
		if (run.exitCode !== 0) return { kind: "status", repo: false, reason: firstLine(run.stderr) };
		const records = run.stdout.split("\0");
		const changes: WorkspaceChange[] = [];
		let branch: string | undefined;
		let head: string | undefined;
		// Only complete records count: output stopped at the cap may end mid-record.
		const complete = run.truncated ? records.slice(0, -1) : records;
		for (let index = 0; index < complete.length; index++) {
			const record = complete[index] ?? "";
			if (record.startsWith("# branch.head ")) branch = record.slice(14);
			else if (record.startsWith("# branch.oid ")) head = record.slice(13);
			else if (record.startsWith("1 ")) changes.push({ status: record.slice(2, 4), path: below(field(record, 8)) });
			else if (record.startsWith("2 ")) {
				changes.push({
					status: record.slice(2, 4),
					path: below(field(record, 9)),
					from: below(complete[index + 1] ?? ""),
				});
				index++;
			} else if (record.startsWith("u "))
				changes.push({ status: record.slice(2, 4), path: below(field(record, 10)) });
			else if (record.startsWith("? ")) changes.push({ status: "??", path: below(record.slice(2)) });
			if (changes.length >= STATUS_LIMIT) break;
		}
		return {
			kind: "status",
			repo: true,
			...(branch && branch !== "(detached)" ? { branch } : {}),
			...(head && head !== "(initial)" ? { head } : {}),
			changes,
			truncated: run.truncated || changes.length >= STATUS_LIMIT,
		};
	}

	/**
	 * Every file below the root, for the name filter. In a repository: tracked and untracked files without ignored ones,
	 * as Quick Open skips them. Elsewhere (or without git): a walk of the directory, skipping `.git` and `node_modules`
	 * folders and not following symlinks.
	 *
	 * The walk is breadth first with each directory's entries in name order (UTF-16 code units; byte order for names
	 * without astral characters, as pi-env's `listDir` and `listFiles`), so a truncated walk keeps the same files on
	 * every filesystem: shallow directories, and earlier names among siblings. Directory order (`openDirReader`) is
	 * the filesystem's hash or creation order and would keep an arbitrary subset.
	 */
	private async files(context: Context): Promise<WorkspaceResult> {
		const root = await this.canonicalRoot(context);
		const base = root === "/" ? "" : root;
		const run = await this.git(
			["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			FILES_BYTES,
			context,
		).catch(() => undefined);
		if (run && (run.exitCode === 0 || run.truncated)) {
			// The text after the last NUL is empty, or a record cut at the output cap. Unmerged files repeat.
			const records = run.stdout.split("\0").slice(0, -1);
			const paths = [...new Set(records)];
			return {
				kind: "files",
				paths: paths.slice(0, FILES_LIMIT),
				truncated: run.truncated || paths.length > FILES_LIMIT,
			};
		}
		const paths: string[] = [];
		const queue = [""];
		let truncated = false;
		for (let index = 0; index < queue.length && !truncated; index++) {
			if (index >= WALK_DIRECTORIES) {
				truncated = true;
				break;
			}
			const relative = queue[index] ?? "";
			const absolute = relative ? `${base}/${relative}` : root;
			const opened = await this.env.openDirReader(absolute, context);
			if (!opened.ok) continue;
			const entries: FileInfo[] = [];
			try {
				for (;;) {
					const page = await opened.value.next(500, context);
					if (!page.ok) break;
					entries.push(...page.value.entries);
					if (entries.length > WALK_DIRECTORY_ENTRIES) {
						truncated = true;
						entries.length = WALK_DIRECTORY_ENTRIES;
						break;
					}
					if (page.value.done) break;
				}
			} finally {
				void opened.value.close(context);
			}
			entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
			for (const entry of entries) {
				const path = relative ? `${relative}/${entry.name}` : entry.name;
				if (entry.kind !== "directory") paths.push(path);
				else if (entry.name !== ".git" && entry.name !== "node_modules") queue.push(path);
				if (paths.length > FILES_LIMIT) {
					truncated = true;
					paths.length = FILES_LIMIT;
					break;
				}
			}
		}
		return { kind: "files", paths, truncated };
	}

	/**
	 * Literal, smart-case (case-insensitive unless the text has capitals) search of text
	 * files below `path`, tracked and untracked, skipping ignored files. Outside a
	 * repository it searches the directory itself. Include/exclude globs relative to
	 * `path` become case-insensitive glob pathspecs; a pattern also matches everything
	 * below a folder it matches. Includes are alternatives; excludes apply to all.
	 */
	private async search(
		query: Extract<WorkspaceQuery, { kind: "search" }>,
		context: Context,
	): Promise<WorkspaceResult> {
		const { text, path } = query;
		if (path) await this.resolve(path, context);
		const include = workspaceGlobs(query.include ?? "");
		const exclude = workspaceGlobs(query.exclude ?? "");
		if (!include || !exclude) throw new Error("Invalid file pattern");
		// Every pathspec carries explicit magic, so the scope path itself stays literal.
		const base = path ? `${path.replace(/[*?[\\]/g, "\\$&")}/` : "";
		const specs = (patterns: string[], magic: string) =>
			patterns.flatMap((pattern) => [`:(${magic})${base}${pattern}`, `:(${magic})${base}${pattern}/**`]);
		const pathspecs = [
			...(include.length ? specs(include, "glob,icase") : path ? [`:(literal)${path}`] : []),
			...specs(exclude, "glob,icase,exclude"),
		];
		const args = [
			"grep",
			"-n",
			"-z",
			"-I",
			"-F",
			"--no-color",
			"--no-textconv",
			"--exclude-standard",
			"-m",
			"20",
			...(text === text.toLowerCase() ? ["-i"] : []),
			"-e",
			text,
			"--",
			...pathspecs,
		];
		const grep = async (mode: string) => {
			let run = await this.git(["grep", mode, ...args.slice(1)], SEARCH_BYTES, context);
			// Git before 2.38 has no grep -m. Keep the byte/time limits and cap each file below instead.
			if (run.exitCode === 129 && run.stderr.includes("unknown switch `m'")) {
				args.splice(args.indexOf("-m"), 2);
				run = await this.git(["grep", mode, ...args.slice(1)], SEARCH_BYTES, context);
			}
			return run;
		};
		let run = await grep("--untracked");
		// Not a repository: search the directory itself.
		if (run.exitCode === 128) run = await grep("--no-index");
		if (run.exitCode > 1) throw new Error(firstLine(run.stderr) ?? "Search failed");
		const matches: WorkspaceMatch[] = [];
		const perFile = new Map<string, number>();
		// Records are path NUL line NUL text LF; a cut record at the output cap is dropped.
		let position = 0;
		while (matches.length < SEARCH_LIMIT) {
			const pathEnd = run.stdout.indexOf("\0", position);
			const lineEnd = pathEnd < 0 ? -1 : run.stdout.indexOf("\0", pathEnd + 1);
			const textEnd = lineEnd < 0 ? -1 : run.stdout.indexOf("\n", lineEnd + 1);
			if (textEnd < 0) break;
			const matchPath = run.stdout.slice(position, pathEnd);
			const count = perFile.get(matchPath) ?? 0;
			if (count < 20) {
				matches.push({
					path: matchPath,
					line: Number(run.stdout.slice(pathEnd + 1, lineEnd)),
					text: run.stdout.slice(lineEnd + 1, textEnd).slice(0, 300),
				});
				perFile.set(matchPath, count + 1);
			}
			position = textEnd + 1;
		}
		return {
			kind: "search",
			text,
			path,
			matches,
			truncated: run.truncated || matches.length >= SEARCH_LIMIT,
		};
	}

	/** The current branch's commits, newest first, with unpushed ones marked when there is an upstream. */
	private async log(skip: number, limit: number, context: Context): Promise<WorkspaceResult> {
		const run = await this.git(
			[
				"log",
				"-z",
				"--format=%H%x1f%h%x1f%an%x1f%at%x1f%s",
				`--skip=${skip}`,
				"-n",
				String(limit + 1),
				"HEAD",
				"--",
			],
			LOG_BYTES,
			context,
		);
		if (run.exitCode !== 0) return { kind: "log", commits: [], more: false };
		const records = run.stdout.split("\0").filter(Boolean);
		if (run.truncated) records.pop();
		const upstream = await this.git(
			["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
			4096,
			context,
		);
		let unpushed: Set<string> | undefined;
		if (upstream.exitCode === 0) {
			const ahead = await this.git(
				["rev-list", "-n", "5000", "HEAD", "--not", "@{upstream}", "--"],
				LOG_BYTES,
				context,
			);
			if (ahead.exitCode === 0) unpushed = new Set(ahead.stdout.split("\n").filter(Boolean));
		}
		const commits = records.slice(0, limit).map((record): WorkspaceCommit => {
			const [hash = "", short = "", author = "", time = "0", subject = ""] = record.split("\x1f");
			return {
				hash,
				short,
				author,
				time: Number(time) * 1000,
				subject,
				...(unpushed ? { unpushed: unpushed.has(hash) } : {}),
			};
		});
		return {
			kind: "log",
			commits,
			more: records.length > limit,
			...(upstream.exitCode === 0 ? { upstream: upstream.stdout.trim() } : {}),
		};
	}

	/** One commit's message and changed files (first parent for merges, the empty tree for a root commit). */
	private async commit(commit: string, context: Context): Promise<WorkspaceResult> {
		const meta = await this.git(["show", "-s", "--format=%H%x1f%an%x1f%at%x1f%B", commit, "--"], 64 * 1024, context);
		if (meta.exitCode !== 0) throw new Error("Unknown commit");
		const [hash = commit, author = "", time = "0", ...message] = meta.stdout.split("\x1f");
		const run = await this.git(
			// Relative to the root (and only below it), as the file and diff queries read paths.
			["show", "--format=", "--name-status", "--relative", "-z", "-M", "--diff-merges=first-parent", hash, "--"],
			STATUS_BYTES,
			context,
		);
		if (run.exitCode !== 0) throw new Error(firstLine(run.stderr) ?? "Cannot read commit");
		const tokens = run.stdout.split("\0");
		if (run.truncated) tokens.pop();
		const changes: WorkspaceChange[] = [];
		for (let index = 0; index < tokens.length && changes.length < STATUS_LIMIT; ) {
			const status = tokens[index++] ?? "";
			if (!status) continue;
			if (status.startsWith("R") || status.startsWith("C")) {
				const from = tokens[index++] ?? "";
				const path = tokens[index++] ?? "";
				if (path) changes.push({ status: `${status[0]}.`, path, from });
			} else {
				const path = tokens[index++] ?? "";
				if (path) changes.push({ status: `${status[0]}.`, path });
			}
		}
		return {
			kind: "commit",
			commit: hash,
			author,
			time: Number(time) * 1000,
			message: message.join("\x1f").trimEnd(),
			changes,
			truncated: run.truncated || changes.length >= STATUS_LIMIT,
		};
	}

	/** A file's change in one commit. */
	private async commitDiff(
		commit: string,
		path: string,
		full: boolean,
		context: Context,
		lines = 3,
	): Promise<WorkspaceResult> {
		const relative = workspacePath(path);
		if (!relative) throw new Error("Invalid workspace path");
		const run = await this.git(
			[
				"show",
				"--format=",
				"--no-color",
				"--no-ext-diff",
				"--no-textconv",
				"--no-relative",
				"--src-prefix=a/",
				"--dst-prefix=b/",
				"--diff-merges=first-parent",
				"-M",
				`--unified=${full ? 1_000_000_000 : lines}`,
				commit,
				"--",
				relative,
			],
			DIFF_BYTES,
			context,
		);
		if (run.exitCode !== 0 && !run.truncated) throw new Error(firstLine(run.stderr) ?? "Diff failed");
		return { kind: "diff", path, full, patch: run.stdout, truncated: run.truncated };
	}

	/** A file as of one commit, read from the repository rather than the working tree. */
	private async fileAt(commit: string, path: string, context: Context): Promise<WorkspaceResult> {
		const relative = workspacePath(path);
		if (!relative) throw new Error("Invalid workspace path");
		// `./`: relative to the root, not to the repository's top level.
		const object = `${commit}:./${relative}`;
		const sized = await this.git(["cat-file", "-s", object], 64, context);
		if (sized.exitCode !== 0) throw new Error("File not found in that commit");
		const size = Number(sized.stdout.trim());
		const run = await this.git(["cat-file", "blob", object], WORKSPACE_TEXT_LIMIT, context);
		if (run.exitCode !== 0 && !run.truncated) throw new Error("Cannot read file");
		// Output arrives decoded; NUL bytes survive decoding and mark binary content.
		if (run.stdout.slice(0, 8192).includes("\0")) return { kind: "file", path, size, binary: true, truncated: false };
		return { kind: "file", path, size, binary: false, text: run.stdout, truncated: run.truncated };
	}

	/**
	 * One chunk of an upload into a folder: chunks append to a hidden temporary file
	 * in that folder, renamed into place by the final one. Existing files are never
	 * overwritten.
	 */
	async write(upload: WorkspaceUpload, context: Context): Promise<void> {
		if (!/^[0-9a-f-]{36}$/.test(upload.token)) throw new Error("Invalid upload");
		const name = upload.name;
		if (!name || name.includes("/") || workspacePath(name) === undefined || name.startsWith(".pi-upload-"))
			throw new Error("Invalid file name");
		const directory = await this.resolve(upload.path, context);
		const prefix = directory === "/" ? "" : directory;
		const target = `${prefix}/${name}`;
		const temp = `${prefix}/.pi-upload-${upload.token}`;
		if (upload.abort) {
			await this.env.remove(temp, { force: true }, context);
			return;
		}
		const free = async () => {
			const exists = await this.env.exists(target, context);
			if (!exists.ok) throw new Error("Cannot write here");
			if (exists.value) throw new Error(`${name} already exists`);
		};
		const bytes = Buffer.from(upload.data, "base64");
		if (upload.offset === 0) await free();
		const written =
			upload.offset === 0
				? await this.env.writeFile(temp, bytes, context)
				: await this.env.appendFile(temp, bytes, context);
		if (!written.ok) throw new Error("Cannot write here");
		if (!upload.final) return;
		try {
			await free();
			const renamed = await this.env.renameFile(temp, target, context);
			if (!renamed.ok) throw new Error("Cannot write here");
		} catch (error) {
			await this.env.remove(temp, { force: true }, context);
			throw error;
		}
	}

	private async diff(path: string, full: boolean, context: Context, lines = 3): Promise<WorkspaceResult> {
		const relative = workspacePath(path);
		// Deleted files have no canonical path: validate lexically and let git scope the pathspec.
		if (!relative) throw new Error("Invalid workspace path");
		const head = await this.git(["rev-parse", "--verify", "-q", "HEAD"], 4096, context);
		let base = head.stdout.trim();
		if (head.exitCode !== 0) {
			// Unborn branch: compare with the empty tree of this repository's hash function.
			const empty = await this.git(["hash-object", "-t", "tree", "--stdin"], 4096, context);
			if (empty.exitCode !== 0) throw new Error(firstLine(empty.stderr) ?? "Not a git repository");
			base = empty.stdout.trim();
		}
		const run = await this.git(
			[
				"diff",
				"--no-color",
				"--no-ext-diff",
				"--no-textconv",
				"--no-relative",
				"--src-prefix=a/",
				"--dst-prefix=b/",
				"--ignore-submodules=dirty",
				"-M",
				`--unified=${full ? 1_000_000_000 : lines}`,
				base,
				"--",
				relative,
			],
			DIFF_BYTES,
			context,
		);
		if (run.exitCode !== 0) throw new Error(firstLine(run.stderr) ?? "Diff failed");
		if (run.stdout || run.truncated) return { kind: "diff", path, full, patch: run.stdout, truncated: run.truncated };
		// Untracked files have no diff against HEAD: show their content as added.
		const absolute = await this.resolve(relative, context).catch(() => undefined);
		const opened = absolute ? await this.env.openBinaryReader(absolute, { noFollow: true }, context) : undefined;
		if (!opened?.ok) return { kind: "diff", path, full, patch: "", truncated: false };
		try {
			const info = await opened.value.info(context);
			const size = info.ok ? info.value.size : 0;
			const read = await opened.value.read(0, Math.min(size, UNTRACKED_BYTES), context);
			const text = read.ok ? decodeText(read.value, size > UNTRACKED_BYTES) : undefined;
			if (text === undefined)
				return {
					kind: "diff",
					path,
					full,
					patch: `diff --git a/${relative} b/${relative}\nnew file\nBinary file b/${relative}\n`,
					truncated: false,
				};
			const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
			const patch = [
				`diff --git a/${relative} b/${relative}`,
				"new file (untracked)",
				"--- /dev/null",
				`+++ b/${relative}`,
				`@@ -0,0 +1,${lines.length} @@`,
				...lines.map((line) => `+${line}`),
			].join("\n");
			return { kind: "diff", path, full, patch: `${patch}\n`, truncated: size > UNTRACKED_BYTES };
		} finally {
			await opened.value.close(context);
		}
	}

	/**
	 * Git without a shell, against untrusted repository configuration: no optional locks
	 * (never blocks the agent's git), no network fetches, no prompts, no pager, no system
	 * config, no fsmonitor, literal pathspecs and every configured clean/smudge filter
	 * disabled. Stdout and stderr are captured separately; stdout beyond `limit` cancels
	 * the command and is reported as truncated.
	 */
	/** `overrides`: filter overrides this request already fetched. */
	private async git(args: string[], limit: number, context: Context, overrides?: Promise<string[]>, cwd?: string) {
		const filters = await (overrides ?? this.filterOverrides(context));
		return this.capture(
			[
				"git",
				"--no-optional-locks",
				// check-ignore rejects the flag; it matches its arguments literally anyway.
				// grep gives each pathspec explicit magic for its file globs.
				...(args[0] === "check-ignore" || args[0] === "grep" ? [] : ["--literal-pathspecs"]),
				"-c",
				"core.fsmonitor=false",
				"-c",
				"core.quotepath=off",
				"-c",
				"core.pager=cat",
				...filters,
				...args,
			],
			limit,
			context,
			cwd,
		);
	}

	private filters?: Promise<string[]>;
	/** Running watchers: while one runs, any change (or watch error) discards the cached filter overrides. */
	private watchers = 0;
	private filterOverrides(context: Context): Promise<string[]> {
		// Clean/process filters run on stat-dirty files during status and diff. Override every configured driver so
		// repository config cannot run programs from the panel. Kept between requests only while a watcher would report
		// a configuration change; otherwise only requests in flight together share them.
		if (this.filters) return this.filters;
		const pending = this.capture(
			["git", "config", "--name-only", "--get-regexp", "^filter\\."],
			64 * 1024,
			context,
		).then((run) => {
			const drivers = new Set(
				run.stdout
					.split("\n")
					.map((line) => /^filter\.(.+)\.[^.]+$/.exec(line.trim())?.[1])
					.filter((name) => name !== undefined),
			);
			return [...drivers].flatMap((name) => [
				"-c",
				`filter.${name}.clean=`,
				"-c",
				`filter.${name}.smudge=`,
				"-c",
				`filter.${name}.process=`,
				"-c",
				`filter.${name}.required=false`,
			]);
		});
		this.filters = pending;
		void pending.then(
			() => {
				if (!this.watchers && this.filters === pending) this.filters = undefined;
			},
			() => {
				if (this.filters === pending) this.filters = undefined;
			},
		);
		return pending;
	}

	private async capture(argv: string[], limit: number, context: Context, cwd?: string) {
		const run = withCancel(context);
		let stdout = "";
		let stderr = "";
		let truncated = false;
		const result = await this.env.exec(
			argv,
			{
				cwd: cwd ?? (await this.canonicalRoot(context)),
				timeout: GIT_TIMEOUT,
				env: {
					GIT_OPTIONAL_LOCKS: "0",
					GIT_NO_LAZY_FETCH: "1",
					GIT_TERMINAL_PROMPT: "0",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_PAGER: "cat",
					LC_ALL: "C",
				},
				onOutput: (text, _context, info) => {
					if (info.stream === "stderr") {
						if (stderr.length < 16 * 1024) stderr += text;
						return;
					}
					if (truncated) return;
					stdout += text;
					if (stdout.length > limit) {
						stdout = stdout.slice(0, limit);
						truncated = true;
						run.cancel(new Error("Output limit reached"));
					}
				},
			},
			run.context,
		);
		if (result.ok) return { exitCode: result.value.exitCode, stdout, stderr, truncated };
		if (truncated) return { exitCode: 0, stdout, stderr, truncated };
		if (result.error.code === "timeout") throw new Error("Git timed out");
		if (result.error.code === "spawn_error") throw new Error("Git is not installed in this environment");
		throw new Error(result.error.message);
	}

	/**
	 * Watch the working tree (without .git internals and node_modules) plus the
	 * repository's HEAD and index, which commits and staging change. A linked worktree
	 * (or a directory below the repository root) has them in a git directory elsewhere,
	 * and its config in the main repository's.
	 */
	async watch(onChange: () => void, context: Context): Promise<FileWatcher | undefined> {
		const root = await this.canonicalRoot(context);
		const located = await this.capture(
			["git", "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
			8192,
			context,
		).catch(() => undefined);
		const [gitDir, commonDir] = located?.exitCode === 0 ? located.stdout.split("\n").map((line) => line.trim()) : [];
		const git = gitDir || `${root === "/" ? "" : root}/.git`;
		const config = `${commonDir || git}/config`;
		// Counted in `watchers` from start until closed or failed: a failed watcher reports nothing more.
		const state = { open: false };
		const stop = () => {
			if (!state.open) return;
			state.open = false;
			this.watchers--;
			this.filters = undefined;
		};
		const tree = await this.watchTargets(root, context);
		context.abortSignal?.throwIfAborted();
		const result = await this.env.watch(
			[...tree, { path: `${git}/HEAD` }, { path: `${git}/index` }, { path: config }],
			(change) => {
				// Any change may be configuration: .git/config, or a file it includes from the working tree.
				this.filters = undefined;
				if (change.kind === "failed") stop();
				else onChange();
			},
			context,
		);
		if (!result.ok) return undefined;
		const watcher = result.value;
		state.open = true;
		this.watchers++;
		return {
			mode: watcher.mode,
			stop: async (stopping) => {
				stop();
				await watcher.stop(stopping);
			},
		};
	}

	/**
	 * The working tree's watch targets: the root recursively, or its own entries only for a tree over
	 * `WATCH_DIRECTORIES` folders. Counted with a walk first (stopping at the bound, and when the watch is abandoned), as
	 * the watcher would scan it.
	 */
	private async watchTargets(root: string, context: Context): Promise<WatchTarget[]> {
		const queue = [root];
		let counted = 0;
		for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
			context.abortSignal?.throwIfAborted();
			const listed = await this.env.listDir(next, context);
			if (!listed.ok) continue;
			for (const entry of listed.value) {
				if (entry.kind !== "directory" || WATCH_EXCLUDED.includes(entry.name)) continue;
				if (++counted > WATCH_DIRECTORIES) return [{ path: root }];
				queue.push(`${next === "/" ? "" : next}/${entry.name}`);
			}
		}
		return [{ path: root, recursive: true, exclude: { names: WATCH_EXCLUDED } }];
	}
}

function field(record: string, index: number): string {
	// Space-separated fields before the path; the path itself may contain spaces.
	let position = 0;
	for (let count = 0; count < index; count++) position = record.indexOf(" ", position) + 1;
	return record.slice(position);
}

function firstLine(text: string): string | undefined {
	return text.trim().split("\n")[0]?.slice(0, 300) || undefined;
}

/** UTF-8 text, or undefined for binary content (NUL bytes or invalid UTF-8). */
function decodeText(bytes: Uint8Array, truncated: boolean): string | undefined {
	if (bytes.subarray(0, 8192).includes(0)) return undefined;
	// A cut inside a multi-byte character is not binary; drop up to three trailing bytes.
	for (let drop = 0; drop <= (truncated ? 3 : 0); drop++) {
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - drop));
		} catch {}
	}
	return undefined;
}
