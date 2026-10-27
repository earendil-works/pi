import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
	type ExecutionEnv,
	type FileChange,
	type FileInfo,
	getOrThrow,
	type ListFilesOptions,
	type Result,
	type ShellOutputInfo,
	type WatchTarget,
} from "../env/index.ts";
import type { EnvConformanceCase, EnvConformanceOptions } from "./types.ts";

const context = BACKGROUND_CONTEXT;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

type EnvTest = (env: ExecutionEnv) => Promise<void>;

function abortedContext(): Context {
	const controller = new AbortController();
	controller.abort();
	return withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
}

function errorCode(result: Result<unknown, { code: string }>): string | undefined {
	return result.ok ? undefined : result.error.code;
}

async function readAll(
	env: ExecutionEnv,
	path: string,
	maxEntries: number,
): Promise<{ pages: FileInfo[][]; done: boolean }> {
	const reader = getOrThrow(await env.openDirReader(path, context));
	const pages: FileInfo[][] = [];
	try {
		for (let page = 0; page < 1000; page++) {
			const next = getOrThrow(await reader.next(maxEntries, context));
			pages.push(next.entries);
			if (next.done) return { pages, done: true };
		}
		return { pages, done: false };
	} finally {
		await reader.close(context);
	}
}

/** A listing as `<kind letter> <path>` lines (`f`, `d`, `l`), with its truncation. */
async function listed(
	env: ExecutionEnv,
	path: string,
	options?: ListFilesOptions,
): Promise<{ entries: string[]; truncated: boolean }> {
	if (env.listFiles === undefined) throw new Error("The environment does not implement listFiles");
	const listing = getOrThrow(await env.listFiles(path, options, context));
	const letter = { file: "f", directory: "d", symlink: "l" } as const;
	return {
		entries: listing.entries.map((entry) => `${letter[entry.kind]} ${entry.path}`),
		truncated: listing.truncated,
	};
}

/** Whether a change reports `path`: an overflow, or a reported path at or above it. */
function covers(change: FileChange, path: string): boolean {
	if ("overflow" in change) return true;
	if (!("paths" in change)) return false;
	return change.paths.some(
		(reported) => path === reported || path.startsWith(`${reported}/`) || path.startsWith(`${reported}\\`),
	);
}

/** Watch `targets` while `run` changes files, with a helper that waits for a change reporting a path. */
async function watching(
	env: ExecutionEnv,
	targets: readonly WatchTarget[],
	run: (helpers: {
		readonly changes: FileChange[];
		/** Wait up to three seconds for a change, after the call, that reports `path`. */
		expectChange(path: string, change: () => Promise<void>): Promise<void>;
		absolute(path: string): Promise<string>;
	}) => Promise<void>,
): Promise<void> {
	const changes: FileChange[] = [];
	const watcher = getOrThrow(await env.watch(targets, (change) => changes.push(change), context));
	try {
		const absolute = async (path: string) => getOrThrow(await env.absolutePath(path, context));
		await run({
			changes,
			absolute,
			async expectChange(path, change) {
				const target = await absolute(path);
				const from = changes.length;
				await change();
				const deadline = Date.now() + 3000;
				while (!changes.slice(from).some((entry) => covers(entry, target))) {
					if (Date.now() > deadline) {
						throw new Error(`No change reported ${target}; got ${JSON.stringify(changes.slice(from))}`);
					}
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			},
		});
	} finally {
		await watcher.close(context);
	}
}

/**
 * Creates runner-independent cases for an `ExecutionEnv`. `withEnv` must call and await its callback exactly once per
 * case with an environment whose `cwd` is a fresh, empty, writable directory.
 */
export function createEnvConformance(options: EnvConformanceOptions): readonly EnvConformanceCase[] {
	const assert = options.assertions;
	const shell = options.shell ?? ["sh", "-c"];
	const symlinks = options.symlinks ?? true;
	const createCase = (name: string, test: EnvTest, timeoutMs?: number): EnvConformanceCase => ({
		name,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
		run: () => options.withEnv(test),
	});
	// Watch cases wait up to three seconds per step, longer than test runners allow by default.
	const watchCase = (name: string, test: EnvTest): EnvConformanceCase => createCase(name, test, 30_000);
	const execCollect = async (env: ExecutionEnv, command: string | readonly string[], cwd?: string) => {
		const output: Record<ShellOutputInfo["stream"], string> = { stdout: "", stderr: "" };
		const result = await env.exec(
			command,
			{
				...(cwd === undefined ? {} : { cwd }),
				onOutput: (text, _context, info) => {
					output[info.stream] += text;
				},
			},
			context,
		);
		return { result, ...output };
	};

	const cases: EnvConformanceCase[] = [
		createCase("binary reader reads byte ranges of the opened file", async (env) => {
			getOrThrow(await env.writeFile("data.txt", "hello world", context));
			const reader = getOrThrow(await env.openBinaryReader("data.txt", undefined, context));
			const info = getOrThrow(await reader.info(context));
			assert.partialDeepEqual(info, { name: "data.txt", kind: "file", size: 11 });
			assert.strictEqual(decoder.decode(getOrThrow(await reader.read(0, 5, context))), "hello");
			assert.strictEqual(decoder.decode(getOrThrow(await reader.read(6, 100, context))), "world");
			assert.strictEqual(getOrThrow(await reader.read(11, 4, context)).length, 0);
			assert.strictEqual(getOrThrow(await reader.read(50, 1, context)).length, 0);
			assert.strictEqual(getOrThrow(await reader.read(3, 0, context)).length, 0);
			assert.strictEqual(errorCode(await reader.read(-1, 1, context)), "invalid");
			assert.strictEqual(errorCode(await reader.read(0, 1.5, context)), "invalid");
			assert.strictEqual(errorCode(await reader.read(0, 1, abortedContext())), "aborted");
			await reader.close(context);
			await reader.close(context);
			assert.strictEqual(errorCode(await reader.read(0, 1, context)), "invalid");
			assert.strictEqual(errorCode(await reader.info(context)), "invalid");
		}),

		createCase("binary reader scans lines like decoding the whole file", async (env) => {
			// A byte-order mark, an invalid sequence before a newline, an empty line, a later U+FEFF, and no final newline.
			const bytes = Uint8Array.from([
				0xef, 0xbb, 0xbf, 0x61, 0x0a, 0xe2, 0x82, 0x0a, 0x0a, 0xef, 0xbb, 0xbf, 0x62, 0x0a, 0xc3, 0xa9,
			]);
			getOrThrow(await env.writeFile("lines.txt", bytes, context));
			const lines = new TextDecoder().decode(bytes).split("\n");
			const reader = getOrThrow(await env.openBinaryReader("lines.txt", undefined, context));
			try {
				const ranges: [number, number | undefined][] = [
					[0, undefined],
					[0, 1],
					[1, 3],
					[2, 3],
					[3, undefined],
					[4, 9],
				];
				for (const [startLine, endLine] of ranges) {
					const scan = getOrThrow(
						await reader.scanLines({ startLine, ...(endLine === undefined ? {} : { endLine }) }, context),
					);
					const selected = lines.slice(startLine, endLine);
					const range = (from: number, to: number) =>
						new TextDecoder("utf-8", { ignoreBOM: from > 0 }).decode(bytes.subarray(from, to));
					assert.strictEqual(scan.newlines, lines.length - 1);
					assert.strictEqual(range(scan.start, scan.end), selected.join("\n"));
					assert.strictEqual(scan.selectedBytes, encoder.encode(selected.join("\n")).length);
					assert.strictEqual(range(scan.start, scan.firstLineEnd), lines[startLine]);
					assert.strictEqual(scan.firstLineBytes, encoder.encode(lines[startLine]).length);
				}
				assert.partialDeepEqual(getOrThrow(await reader.scanLines({ startLine: 9 }, context)), {
					start: bytes.length,
					end: bytes.length,
					selectedBytes: 0,
				});
				assert.strictEqual(errorCode(await reader.scanLines({ startLine: 2, endLine: 2 }, context)), "invalid");
			} finally {
				await reader.close(context);
			}
		}),

		createCase("binary reader keeps reading the file it opened after a rename", async (env) => {
			getOrThrow(await env.writeFile("a.txt", "one", context));
			const reader = getOrThrow(await env.openBinaryReader("a.txt", undefined, context));
			try {
				getOrThrow(await env.renameFile("a.txt", "b.txt", context));
				getOrThrow(await env.writeFile("a.txt", "two", context));
				assert.strictEqual(decoder.decode(getOrThrow(await reader.read(0, 10, context))), "one");
			} finally {
				await reader.close(context);
			}
		}),

		createCase("binary reader refuses directories, missing files and aborted opens", async (env) => {
			getOrThrow(await env.createDir("dir", undefined, context));
			getOrThrow(await env.writeFile("file.txt", "x", context));
			assert.strictEqual(errorCode(await env.openBinaryReader("dir", undefined, context)), "is_directory");
			assert.strictEqual(errorCode(await env.openBinaryReader("missing.txt", undefined, context)), "not_found");
			assert.strictEqual(errorCode(await env.openBinaryReader("file.txt", undefined, abortedContext())), "aborted");
		}),

		createCase("directory reader pages every entry exactly once", async (env) => {
			const names = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];
			for (const name of names) getOrThrow(await env.writeFile(name, name, context));
			getOrThrow(await env.createDir("sub", undefined, context));
			const { pages, done } = await readAll(env, ".", 2);
			assert.ok(done, "directory reader reached the end");
			for (const page of pages) assert.ok(page.length <= 2, "page within maxEntries");
			const entries = pages.flat();
			assert.deepEqual(entries.map((entry) => entry.name).sort(), [...names, "sub"].sort());
			assert.strictEqual(entries.find((entry) => entry.name === "sub")?.kind, "directory");
			assert.partialDeepEqual(
				entries.find((entry) => entry.name === "a.txt"),
				{ kind: "file", size: 5 },
			);
		}),

		createCase("directory reader reports the end and refuses use after close", async (env) => {
			getOrThrow(await env.createDir("empty", undefined, context));
			const reader = getOrThrow(await env.openDirReader("empty", context));
			assert.deepEqual(getOrThrow(await reader.next(10, context)), { entries: [], done: true });
			assert.deepEqual(getOrThrow(await reader.next(10, context)), { entries: [], done: true });
			assert.strictEqual(errorCode(await reader.next(0, context)), "invalid");
			assert.strictEqual(errorCode(await reader.next(1, abortedContext())), "aborted");
			await reader.close(context);
			await reader.close(context);
			assert.strictEqual(errorCode(await reader.next(1, context)), "invalid");
		}),

		createCase("directory reader refuses missing paths and files", async (env) => {
			getOrThrow(await env.writeFile("file.txt", "x", context));
			assert.strictEqual(errorCode(await env.openDirReader("missing", context)), "not_found");
			const file = await env.openDirReader("file.txt", context);
			assert.strictEqual(errorCode(file), "not_directory");
			assert.strictEqual(errorCode(await env.openDirReader(".", abortedContext())), "aborted");
		}),

		createCase("directory reader skips entries removed during enumeration", async (env) => {
			getOrThrow(await env.createDir("dir", undefined, context));
			for (const name of ["x", "y", "z"]) getOrThrow(await env.writeFile(`dir/${name}`, name, context));
			const reader = getOrThrow(await env.openDirReader("dir", context));
			try {
				for (const name of ["x", "y", "z"]) getOrThrow(await env.remove(`dir/${name}`, undefined, context));
				const entries: FileInfo[] = [];
				for (let page = 0; page < 10; page++) {
					const next = getOrThrow(await reader.next(10, context));
					entries.push(...next.entries);
					if (next.done) break;
				}
				assert.deepEqual(entries, []);
			} finally {
				await reader.close(context);
			}
		}),

		watchCase("watch reports a missing file's creation, changes, replacement and removal", async (env) => {
			await watching(env, [{ path: "AGENTS.md" }], async ({ expectChange }) => {
				await expectChange("AGENTS.md", async () => {
					getOrThrow(await env.writeFile("AGENTS.md", "one", context));
				});
				await expectChange("AGENTS.md", async () => {
					getOrThrow(await env.writeFile("AGENTS.md", "two!", context));
				});
				// Editors replace a file by renaming a new one over it.
				await expectChange("AGENTS.md", async () => {
					getOrThrow(await env.writeFile("AGENTS.md.tmp", "three", context));
					getOrThrow(await env.renameFile("AGENTS.md.tmp", "AGENTS.md", context));
				});
				await expectChange("AGENTS.md", async () => {
					getOrThrow(await env.writeFile("AGENTS.md", "four", context));
				});
				await expectChange("AGENTS.md", async () => {
					getOrThrow(await env.remove("AGENTS.md", undefined, context));
				});
			});
		}),

		watchCase("watch reports a missing target whose ancestors are created", async (env) => {
			await watching(env, [{ path: "a/b/c/AGENTS.md" }], async ({ expectChange }) => {
				await expectChange("a/b/c/AGENTS.md", async () => {
					getOrThrow(await env.writeFile("a/b/c/AGENTS.md", "x", context));
				});
			});
		}),

		watchCase("watch follows directories created together with their contents", async (env) => {
			getOrThrow(await env.createDir("skills", undefined, context));
			await watching(env, [{ path: "skills", recursive: true }], async ({ expectChange }) => {
				// Written before any watcher on the new directories can exist.
				await expectChange("skills/a/b/SKILL.md", async () => {
					getOrThrow(await env.writeFile("skills/a/b/SKILL.md", "one", context));
				});
				await expectChange("skills/a/b/SKILL.md", async () => {
					getOrThrow(await env.writeFile("skills/a/b/SKILL.md", "two!", context));
				});
				await expectChange("skills/a/b/c/SKILL.md", async () => {
					getOrThrow(await env.writeFile("skills/a/b/c/SKILL.md", "deeper", context));
				});
			});
		}),

		watchCase("watch keeps watching a path whose parent is renamed and recreated", async (env) => {
			getOrThrow(await env.writeFile("proj/.pi/skills/x.md", "x", context));
			await watching(env, [{ path: "proj/.pi/skills", recursive: true }], async ({ expectChange }) => {
				await expectChange("proj/.pi/skills", async () => {
					getOrThrow(await env.renameFile("proj/.pi", "proj/old", context));
				});
				await expectChange("proj/.pi/skills/y.md", async () => {
					getOrThrow(await env.writeFile("proj/.pi/skills/y.md", "y", context));
				});
				await expectChange("proj/.pi/skills/y.md", async () => {
					getOrThrow(await env.writeFile("proj/.pi/skills/y.md", "yy", context));
				});
			});
		}),

		watchCase("watch skips excluded entries and reports a rename out of them", async (env) => {
			getOrThrow(await env.createDir("skills", undefined, context));
			const targets: WatchTarget[] = [
				{ path: "skills", recursive: true, exclude: { hidden: true, names: ["node_modules"] } },
			];
			await watching(env, targets, async ({ changes, expectChange, absolute }) => {
				getOrThrow(await env.writeFile("skills/node_modules/dep/SKILL.md", "dep", context));
				getOrThrow(await env.writeFile("skills/.SKILL.md.tmp", "draft", context));
				await expectChange("skills/SKILL.md", async () => {
					getOrThrow(await env.renameFile("skills/.SKILL.md.tmp", "skills/SKILL.md", context));
				});
				const hidden = [await absolute("skills/node_modules"), await absolute("skills/.SKILL.md.tmp")];
				for (const change of changes) {
					if (!("paths" in change)) continue;
					for (const path of change.paths) {
						assert.ok(
							!hidden.some((excluded) => path === excluded || path.startsWith(excluded)),
							`excluded ${path}`,
						);
					}
				}
			});
		}),

		watchCase("watch keeps recursive coverage where a non-recursive target overlaps", async (env) => {
			getOrThrow(await env.writeFile("skills/a/one.md", "one", context));
			const targets: WatchTarget[] = [{ path: "skills" }, { path: "skills", recursive: true }];
			await watching(env, targets, async ({ expectChange }) => {
				await expectChange("skills/a/two.md", async () => {
					getOrThrow(await env.writeFile("skills/a/two.md", "two", context));
				});
			});
		}),

		watchCase("watch follows a directory replaced at the same path", async (env) => {
			getOrThrow(await env.writeFile("skills/a/x.md", "x", context));
			await watching(env, [{ path: "skills", recursive: true }], async ({ expectChange }) => {
				await expectChange("skills/a", async () => {
					getOrThrow(await env.renameFile("skills/a", "skills-old", context));
					getOrThrow(await env.createDir("skills/a", undefined, context));
				});
				await expectChange("skills/a/y.md", async () => {
					getOrThrow(await env.writeFile("skills/a/y.md", "y", context));
				});
				await expectChange("skills/a/y.md", async () => {
					getOrThrow(await env.writeFile("skills/a/y.md", "yy", context));
				});
			});
		}),

		watchCase("watch stops reporting once closed", async (env) => {
			const changes: FileChange[] = [];
			const watcher = getOrThrow(await env.watch([{ path: "file.txt" }], (change) => changes.push(change), context));
			assert.ok(watcher.mode === "native" || watcher.mode === "polling", "watcher reports its mode");
			await watcher.close(context);
			await watcher.close(context);
			getOrThrow(await env.writeFile("file.txt", "x", context));
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.deepEqual(changes, []);
		}),

		createCase("argv exec passes arguments to the program without shell parsing", async (env) => {
			const hostile = "it's $(touch pwned) `touch pwned` *; touch pwned";
			const { result, stdout } = await execCollect(env, [
				...shell,
				'printf "%s|%s" "$1" "$2"',
				"argv0",
				hostile,
				"a b",
			]);
			assert.strictEqual(getOrThrow(result).exitCode, 0);
			assert.strictEqual(stdout, `${hostile}|a b`);
			assert.strictEqual(getOrThrow(await env.exists("pwned", context)), false);
		}),

		createCase("exec reports the stream of every chunk in both forms", async (env) => {
			const script = "printf out; printf err >&2; printf more";
			const argv = await execCollect(env, [...shell, script]);
			assert.strictEqual(getOrThrow(argv.result).exitCode, 0);
			assert.strictEqual(argv.stdout, "outmore");
			assert.strictEqual(argv.stderr, "err");
			const string = await execCollect(env, script);
			assert.strictEqual(getOrThrow(string.result).exitCode, 0);
			assert.strictEqual(string.stdout, "outmore");
			assert.strictEqual(string.stderr, "err");
		}),

		createCase("argv exec honors cwd and exit codes", async (env) => {
			getOrThrow(await env.createDir("sub", undefined, context));
			const made = await execCollect(env, [...shell, "printf x > made.txt; exit 3"], "sub");
			assert.strictEqual(getOrThrow(made.result).exitCode, 3);
			assert.strictEqual(getOrThrow(await env.readTextFile("sub/made.txt", context)), "x");
		}),

		createCase("argv exec reports missing programs and empty argv as spawn errors", async (env) => {
			assert.strictEqual(
				errorCode(await env.exec(["pi-durable-conformance-missing-program"], undefined, context)),
				"spawn_error",
			);
			assert.strictEqual(errorCode(await env.exec([], undefined, context)), "spawn_error");
		}),

		createCase("windowed exec keeps the exact tail and counts what it skips", async (env) => {
			const lines = 2000;
			const window = { maxBytes: 200, maxLines: 5, minIntervalMs: 0, bytesPerSecond: 1_000_000_000 };
			let bytes = 0;
			let newlines = 0;
			let tail = "";
			const result = await env.exec(
				[...shell, `i=0; while [ $i -lt ${lines} ]; do echo line-$i; i=$((i+1)); done`],
				{
					window,
					onOutput: (text, _context, info) => {
						if (info.skipped !== undefined) {
							bytes += info.skipped.bytes;
							newlines += info.skipped.newlines;
							const after = encoder.encode(text).length;
							const afterNewlines = text.split("\n").length - 1;
							assert.ok(
								after > window.maxBytes || afterNewlines > window.maxLines,
								"a skip is followed by more than the window",
							);
							tail = "";
						}
						bytes += encoder.encode(text).length;
						newlines += text.split("\n").length - 1;
						tail += text;
					},
				},
				context,
			);
			assert.strictEqual(getOrThrow(result).exitCode, 0);
			const expected = Array.from({ length: lines }, (_, index) => `line-${index}\n`);
			assert.strictEqual(bytes, expected.join("").length);
			assert.strictEqual(newlines, lines);
			assert.ok(tail.endsWith(expected.slice(-window.maxLines).join("")), "the delivered output ends with the tail");
		}),

		createCase("argv exec distinguishes timeout from abort", async (env) => {
			const timedOut = await env.exec([...shell, "sleep 2"], { timeout: 0.1 }, context);
			assert.strictEqual(errorCode(timedOut), "timeout");
			const controller = new AbortController();
			const running = env.exec([...shell, "sleep 2"], undefined, withAbortSignal(controller.signal, context));
			setTimeout(() => controller.abort(), 100);
			assert.strictEqual(errorCode(await running), "aborted");
		}),
	];

	if (options.listFiles) {
		const writeAll = async (env: ExecutionEnv, files: readonly string[]) => {
			for (const file of files) getOrThrow(await env.writeFile(file, "", context));
		};
		cases.push(
			createCase("listFiles lists files and directories depth first in name order", async (env) => {
				await writeAll(env, ["b.txt", "a/z.txt", "a/b/c.txt", ".hidden/x", "A.txt"]);
				getOrThrow(await env.createDir("empty", undefined, context));
				assert.deepEqual(await listed(env, "."), {
					entries: [
						"d .hidden",
						"f .hidden/x",
						"f A.txt",
						"d a",
						"d a/b",
						"f a/b/c.txt",
						"f a/z.txt",
						"f b.txt",
						"d empty",
					],
					truncated: false,
				});
				assert.deepEqual((await listed(env, ".", { hidden: false })).entries, [
					"f A.txt",
					"d a",
					"d a/b",
					"f a/b/c.txt",
					"f a/z.txt",
					"f b.txt",
					"d empty",
				]);
				const expected = { entries: ["d b", "f b/c.txt", "f z.txt"], truncated: false };
				assert.deepEqual(await listed(env, "a"), expected);
				assert.deepEqual(await listed(env, getOrThrow(await env.absolutePath("a", context))), expected);
				assert.deepEqual(await listed(env, "empty"), { entries: [], truncated: false });
			}),

			createCase("listFiles skips what git ignores in work trees, .git, and excluded names", async (env) => {
				await writeAll(env, ["keep.txt", "out/x.js", "sub/keep.txt", "sub/drop.log", "node_modules/m/i.js"]);
				getOrThrow(await env.writeFile(".gitignore", "out/\n*.log\n", context));
				getOrThrow(await env.writeFile("sub/.gitignore", "!keep.txt\n", context));
				// Not a work tree yet: `.gitignore` files have no effect.
				assert.ok((await listed(env, ".")).entries.includes("f out/x.js"));
				getOrThrow(await env.writeFile(".git/HEAD", "ref: refs/heads/main\n", context));
				getOrThrow(await env.writeFile(".git/info/exclude", "keep.txt\n", context));
				assert.deepEqual((await listed(env, ".", { exclude: ["node_modules"] })).entries, [
					"f .gitignore",
					"d sub",
					"f sub/.gitignore",
					"f sub/keep.txt",
				]);
				// A directory inside the work tree applies its parents' rules.
				assert.deepEqual((await listed(env, "sub")).entries, ["f .gitignore", "f keep.txt"]);
				const all = (await listed(env, ".", { gitignore: false })).entries;
				assert.ok(
					all.includes("f out/x.js") && all.includes("f node_modules/m/i.js") && all.includes("f keep.txt"),
				);
				assert.ok(!all.some((entry) => entry.includes(".git/") || entry === "d .git"));
			}),

			createCase("listFiles stops at its bounds and reports truncated", async (env) => {
				await writeAll(env, ["a", "b", "c"]);
				assert.deepEqual(await listed(env, ".", { maxEntries: 2 }), { entries: ["f a", "f b"], truncated: true });
				assert.deepEqual(await listed(env, ".", { maxEntries: 3 }), {
					entries: ["f a", "f b", "f c"],
					truncated: false,
				});
				// Each entry counts its path plus two bytes.
				assert.deepEqual(await listed(env, ".", { maxBytes: 6 }), { entries: ["f a", "f b"], truncated: true });
				assert.deepEqual(await listed(env, ".", { maxEntries: 0 }), { entries: [], truncated: true });
				assert.strictEqual(errorCode(await env.listFiles!(".", { maxEntries: -1 }, context)), "invalid");
				assert.strictEqual(errorCode(await env.listFiles!(".", { timeoutMs: 1.5 }, context)), "invalid");
			}),

			createCase("listFiles fails on missing directories, files, and aborts", async (env) => {
				getOrThrow(await env.writeFile("file.txt", "", context));
				assert.strictEqual(errorCode(await env.listFiles!("missing", undefined, context)), "not_found");
				assert.strictEqual(errorCode(await env.listFiles!("file.txt", undefined, context)), "not_directory");
				assert.strictEqual(errorCode(await env.listFiles!(".", undefined, abortedContext())), "aborted");
			}),
		);
	}

	if (symlinks && options.listFiles) {
		cases.push(
			createCase("listFiles lists symbolic links without following them", async (env) => {
				getOrThrow(await env.writeFile("dir/inner.txt", "", context));
				const linked = await env.exec(
					[...shell, "ln -s dir link && ln -s missing dangling && ln -s .. dir/loop"],
					undefined,
					context,
				);
				assert.strictEqual(getOrThrow(linked).exitCode, 0);
				assert.deepEqual((await listed(env, ".")).entries, [
					"l dangling",
					"d dir",
					"f dir/inner.txt",
					"l dir/loop",
					"l link",
				]);
				// The listed directory itself may be a link.
				assert.deepEqual((await listed(env, "link")).entries, ["f inner.txt", "l loop"]);
			}),
		);
	}

	if (symlinks) {
		cases.push(
			createCase("binary reader follows symlinks unless noFollow refuses the final one", async (env) => {
				getOrThrow(await env.writeFile("target.txt", "target", context));
				getOrThrow(await env.createDir("sub", undefined, context));
				getOrThrow(await env.writeFile("sub/inner.txt", "inner", context));
				const linked = await env.exec(
					[...shell, "ln -s target.txt link.txt && ln -s sub dirlink"],
					undefined,
					context,
				);
				assert.strictEqual(getOrThrow(linked).exitCode, 0);

				const followed = getOrThrow(await env.openBinaryReader("link.txt", undefined, context));
				assert.strictEqual(decoder.decode(getOrThrow(await followed.read(0, 10, context))), "target");
				await followed.close(context);

				assert.strictEqual(
					errorCode(await env.openBinaryReader("link.txt", { noFollow: true }, context)),
					"invalid",
				);

				// Only the final component is refused; earlier symlinked directories still resolve.
				const inner = getOrThrow(await env.openBinaryReader("dirlink/inner.txt", { noFollow: true }, context));
				assert.strictEqual(decoder.decode(getOrThrow(await inner.read(0, 10, context))), "inner");
				await inner.close(context);
			}),

			watchCase("watch reports changes to the file a watched symbolic link points to", async (env) => {
				getOrThrow(await env.writeFile("data/real.md", "one", context));
				getOrThrow(await env.createDir("config", undefined, context));
				const linked = await env.exec([...shell, "ln -s ../data/real.md config/AGENTS.md"], undefined, context);
				assert.strictEqual(getOrThrow(linked).exitCode, 0);
				await watching(env, [{ path: "config/AGENTS.md" }], async ({ expectChange }) => {
					await expectChange("config/AGENTS.md", async () => {
						getOrThrow(await env.writeFile("data/real.md", "two!", context));
					});
				});
			}),
		);
	}

	return cases;
}
