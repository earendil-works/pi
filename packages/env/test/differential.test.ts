import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ExecutionEnv, FileError, Result } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool, createReadTool } from "@earendil-works/pi-durable/tools";
import { afterAll, describe, expect, it } from "vitest";
import { Connection } from "../src/connection.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";
import { daemon } from "./daemon.ts";

const connection = new Connection({ command: [daemon] });
const context: Context = BACKGROUND_CONTEXT;
const dirs: string[] = [];
afterAll(() => {
	connection.close();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
});

function pair(): { local: ExecutionEnv; remote: ExecutionEnv; roots: [string, string] } {
	const localRoot = mkdtempSync(join(tmpdir(), "pi-env-local-"));
	const remoteRoot = mkdtempSync(join(tmpdir(), "pi-env-remote-"));
	dirs.push(localRoot, remoteRoot);
	return {
		local: new NodeExecutionEnv({ cwd: localRoot }),
		remote: new RemoteExecutionEnv({ connection, id: "pi-env:test", cwd: remoteRoot }),
		roots: [localRoot, remoteRoot],
	};
}

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A result with the environment's root replaced and only the error code of failures, for comparison. */
function normalize(value: unknown, root: string): unknown {
	const json = JSON.stringify(value, (key, field: unknown) => {
		if (field instanceof Uint8Array) return { bytes: Buffer.from(field).toString("hex") };
		if (key === "mtimeMs") return "mtime";
		if (field && typeof field === "object" && "ok" in field && (field as Result<unknown, FileError>).ok === false) {
			return { ok: false, code: (field as unknown as { error: FileError }).error.code };
		}
		return field;
	});
	if (json === undefined) return undefined;
	// Roots appear JSON-escaped (backslashes doubled on Windows), and resolved paths spell them without Windows' 8.3
	// short names (RUNNER~1).
	const escaped = (path: string) => JSON.stringify(path).slice(1, -1);
	return JSON.parse(json.replaceAll(escaped(realpathSync.native(root)), "<root>").replaceAll(escaped(root), "<root>"));
}

const NAMES = ["a.txt", "b", "dir", "dir/c.txt", "dir/sub", "dir/sub/d.bin", "missing", "a.txt/x"];
const CONTENTS: (string | Uint8Array)[] = [
	"",
	"hello\n",
	"\ufeffbom\r\nline",
	Uint8Array.from([0xe2, 0x82, 0x0a, 0xff, 0xef, 0xbb, 0xbf]),
	"x".repeat(70_000),
	// Crosses write chunks, read chunks and multi-byte characters split between them.
	"é".repeat(300_001),
];

type Operation = (env: ExecutionEnv) => Promise<unknown>;

/** A random operation with its arguments fixed, and a label for failure messages. */
function randomOperation(next: () => number): { label: string; run: Operation } {
	const args: unknown[] = [];
	const pick = <T>(value: T): T => {
		args.push(
			value instanceof Uint8Array
				? "<bytes>"
				: typeof value === "string" && value.length > 20
					? `<${value.length} chars>`
					: value,
		);
		return value;
	};
	const nameValue = () => pick(NAMES[Math.floor(next() * NAMES.length)]!);
	const contentValue = () => pick(CONTENTS[Math.floor(next() * CONTENTS.length)]!);
	const flagValue = () => pick(next() < 0.5);
	const small = (limit: number) => pick(Math.floor(next() * limit));
	const choices: [string, () => Operation][] = [
		[
			"writeFile",
			() => {
				const n = nameValue();
				const c = contentValue();
				return (env) => env.writeFile(n, c, context);
			},
		],
		[
			"appendFile",
			() => {
				const n = nameValue();
				const c = contentValue();
				return (env) => env.appendFile(n, c, context);
			},
		],
		[
			"readTextFile",
			() => {
				const n = nameValue();
				return (env) => env.readTextFile(n, context);
			},
		],
		[
			"readBinaryFile",
			() => {
				const n = nameValue();
				return (env) => env.readBinaryFile(n, context);
			},
		],
		[
			"readTextLines",
			() => {
				const n = nameValue();
				const m = small(4);
				return (env) => env.readTextLines(n, { maxLines: m }, context);
			},
		],
		[
			"fileInfo",
			() => {
				const n = nameValue();
				return (env) => env.fileInfo(n, context);
			},
		],
		[
			"exists",
			() => {
				const n = nameValue();
				return (env) => env.exists(n, context);
			},
		],
		[
			"listDir",
			() => {
				const n = nameValue();
				return (env) => env.listDir(n, context);
			},
		],
		[
			"createDir",
			() => {
				const n = nameValue();
				const r = flagValue();
				return (env) => env.createDir(n, { recursive: r }, context);
			},
		],
		[
			"remove",
			() => {
				const n = nameValue();
				const r = flagValue();
				const f = flagValue();
				return (env) => env.remove(n, { recursive: r, force: f }, context);
			},
		],
		[
			"renameFile",
			() => {
				const a = nameValue();
				const b = nameValue();
				return (env) => env.renameFile(a, b, context);
			},
		],
		[
			"truncateFile",
			() => {
				const n = nameValue();
				const size = small(10);
				return (env) => env.truncateFile(n, size, context);
			},
		],
		[
			"flushFile",
			() => {
				const n = nameValue();
				return (env) => env.flushFile(n, context);
			},
		],
		[
			"canonicalPath",
			() => {
				const n = nameValue();
				return (env) => env.canonicalPath(n, context);
			},
		],
		[
			"openBinaryReader",
			() => {
				const n = nameValue();
				const noFollow = flagValue();
				const offset = small(8);
				const length = small(8);
				return async (env) => {
					const reader = await env.openBinaryReader(n, { noFollow }, context);
					if (!reader.ok) return reader;
					try {
						return [
							await reader.value.read(offset, length, context),
							await reader.value.scanLines({ startLine: 0 }, context),
						];
					} finally {
						await reader.value.close(context);
					}
				};
			},
		],
	];
	const [label, make] = choices[Math.floor(next() * choices.length)]!;
	const run = make();
	return { label: `${label}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`, run };
}

describe("RemoteExecutionEnv against NodeExecutionEnv", () => {
	it("gives the same results for random file operation sequences", async () => {
		for (let seed = 1; seed <= 60; seed++) {
			const next = random(seed);
			const { local, remote, roots } = pair();
			for (let step = 0; step < 25; step++) {
				const operation = randomOperation(next);
				const expected = normalize(await operation.run(local), roots[0]);
				const actual = normalize(await operation.run(remote), roots[1]);
				expect(actual, `seed ${seed} step ${step} ${operation.label}`).toEqual(expected);
			}
		}
	}, 120_000);

	it.skipIf(process.platform === "win32")(
		"reads devices, FIFOs and directories like Node",
		async () => {
			const { local, remote, roots } = pair();
			const results = async (env: ExecutionEnv, root: string) => {
				const fifo = join(root, "fifo");
				const made = await env.exec(["mkfifo", fifo], undefined, context);
				if (!made.ok || made.value.exitCode !== 0) throw new Error("mkfifo failed");
				await env.createDir("dir", undefined, context);
				// A writer for each blocking open of the FIFO.
				const write = (text: string) => spawn("sh", ["-c", `printf '%s' "$1" > "$2"`, "sh", text, fifo]);
				write("fifo text\n");
				const fifoText = await env.readTextFile("fifo", context);
				write("fifo bytes");
				const fifoBytes = await env.readBinaryFile("fifo", context);
				write("x");
				const fifoLines = await env.readTextLines("fifo", undefined, context);
				const dirReader = await env.openTextLineReader("dir", context);
				const dirLine = dirReader.ok ? await dirReader.value.readLine(context) : undefined;
				if (dirReader.ok) await dirReader.value.close(context);
				return normalize(
					{
						nullText: await env.readTextFile("/dev/null", context),
						nullBytes: await env.readBinaryFile("/dev/null", context),
						nullLines: await env.readTextLines("/dev/null", undefined, context),
						fifoText,
						fifoBytes,
						fifoLines,
						dirReaderOpened: dirReader.ok,
						dirLine,
						dirText: await env.readTextFile("dir", context),
						dirBytes: await env.readBinaryFile("dir", context),
					},
					root,
				);
			};
			expect(await results(remote, roots[1])).toEqual(await results(local, roots[0]));
		},
		30_000,
	);

	// macOS file systems refuse names that are not UTF-8.
	it.skipIf(process.platform !== "linux" && process.platform !== "android")(
		"lists names that are not UTF-8 like Node",
		async () => {
			const { local, remote, roots } = pair();
			for (const root of roots) {
				for (const name of [[0x62], [0x61, 0xff], [0xc3, 0xa9], [0x61, 0xfe, 0x7a], [0x7a]]) {
					writeFileSync(Buffer.concat([Buffer.from(`${root}/`), Buffer.from(name)]), "x");
				}
			}
			const results = async (env: ExecutionEnv, root: string) => {
				const reader = await env.openDirReader(".", context);
				const pages: unknown[] = [];
				if (reader.ok) {
					for (let done = false; !done; ) {
						const page = await reader.value.next(2, context);
						pages.push(page);
						done = !page.ok || page.value.done;
					}
					await reader.value.close(context);
				}
				return normalize({ list: await env.listDir(".", context), pages }, root);
			};
			expect(await results(remote, roots[1])).toEqual(await results(local, roots[0]));
		},
	);

	it("gives the same read and bash tool results", async () => {
		const { local, remote, roots } = pair();
		const files: [string, string | Uint8Array][] = [
			["text.txt", "one\ntwo\n\nthree"],
			["big.txt", "line\n".repeat(3000)],
			["long.txt", `${"é".repeat(40_000)}\nend`],
			["bom.txt", "\ufeffhello"],
			["bad.txt", Uint8Array.from([0x61, 0xe2, 0x82, 0x0a, 0x62])],
		];
		for (const [path, content] of files) {
			await local.writeFile(path, content, context);
			await remote.writeFile(path, content, context);
		}
		const api = (env: ExecutionEnv, output: string[]) =>
			({
				env,
				outputWindow: undefined,
				output: (chunk: string | Uint8Array) => output.push(String(chunk)),
				diagnostic: () => {},
				details: async () => {},
			}) as unknown as ToolExecutionApi;
		const run = async (
			env: ExecutionEnv,
			tool: ReturnType<typeof createReadTool> | ReturnType<typeof createBashTool>,
			args: object,
		) => {
			const output: string[] = [];
			try {
				const result = await tool.execute(args as never, api(env, output), context);
				return { result, output: output.join("") };
			} catch (error) {
				return { error: (error as Error).message, output: output.join("") };
			}
		};
		const cases: [ReturnType<typeof createReadTool> | ReturnType<typeof createBashTool>, object][] = [
			[createReadTool(), { path: "text.txt" }],
			[createReadTool(), { path: "text.txt", offset: 2, limit: 1 }],
			[createReadTool(), { path: "big.txt" }],
			[createReadTool(), { path: "long.txt" }],
			[createReadTool(), { path: "bom.txt" }],
			[createReadTool(), { path: "bad.txt" }],
			[createReadTool(), { path: "missing.txt" }],
			[createBashTool(), { command: "cat text.txt; echo err >&2; exit 0" }],
			[createBashTool(), { command: "exit 3" }],
			[createBashTool(), { command: "printf 'a\\nb'; ls" }],
		];
		for (const [tool, args] of cases) {
			const expected = normalize(await run(local, tool, args), roots[0]);
			const actual = normalize(await run(remote, tool, args), roots[1]);
			expect(actual, JSON.stringify(args)).toEqual(expected);
		}
	}, 60_000);
});
