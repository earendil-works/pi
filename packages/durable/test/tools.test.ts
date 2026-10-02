// Ported from packages/agent/test/harness/tools.test.ts and adapted to ToolRegistration: tools take the environment
// from `api.env`, stream through `api.output()`, and report notices as diagnostics instead of content text.
import { mkdirSync, rmSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type {
	ToolDiagnostic,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import { applyPatch } from "diff";
import { afterAll, describe, expect, it } from "vitest";
import {
	type ExecutionEnv,
	ExecutionError,
	err,
	type FileError,
	getOrThrow,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
} from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { withFileMutationQueue } from "../src/tools/file-mutation-queue.ts";
import { detectSupportedImageMimeType } from "../src/tools/image.ts";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "../src/tools/index.ts";
import { DEFAULT_MAX_LINES } from "../src/truncate.ts";

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function createTempDir(): string {
	const dir = join(tmpdir(), `pi-durable-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

function createEnv(): NodeExecutionEnv {
	return new NodeExecutionEnv({ cwd: createTempDir() });
}

/** A minimal execution API: the environment, collected output and diagnostics, and nothing durable. */
function fakeApi(env: ExecutionEnv | undefined): {
	api: ToolExecutionApi;
	output: string[];
	diagnostics: ToolDiagnostic[];
} {
	const output: string[] = [];
	const diagnostics: ToolDiagnostic[] = [];
	const api = {
		taskId: 1,
		conversationId: 1,
		callId: "call",
		env,
		output: (chunk: string | Uint8Array) =>
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)),
		diagnostic: (diagnostic: ToolDiagnostic) => diagnostics.push(diagnostic),
		details: async () => {},
	} as unknown as ToolExecutionApi;
	return { api, output, diagnostics };
}

async function run(
	tool: ToolRegistration,
	args: JsonValue,
	env: ExecutionEnv | undefined,
	context: Context = BACKGROUND_CONTEXT,
): Promise<ToolExecutionResult & { output: string[]; reported: ToolDiagnostic[] }> {
	const { api, output, diagnostics } = fakeApi(env);
	return { ...(await tool.execute(args, api, context)), output, reported: diagnostics };
}

/** Run a tool expected to throw; returns the error with what it streamed and reported first. */
async function runFailing(
	tool: ToolRegistration,
	args: JsonValue,
	env: ExecutionEnv,
): Promise<{ error: Error; output: string[]; reported: ToolDiagnostic[] }> {
	const { api, output, diagnostics } = fakeApi(env);
	try {
		await tool.execute(args, api, BACKGROUND_CONTEXT);
	} catch (error) {
		return { error: error as Error, output, reported: diagnostics };
	}
	throw new Error("Expected the tool to throw");
}

function textOutput(result: ToolExecutionResult): string {
	return (result.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function diagnosticText(result: ToolExecutionResult): string {
	return (result.diagnostics ?? []).map((diagnostic) => diagnostic.message).join("\n");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class SlowReadExecutionEnv extends NodeExecutionEnv {
	override async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		await delay(20);
		return super.readTextFile(path, context);
	}
}

class BlockingWriteExecutionEnv extends NodeExecutionEnv {
	readonly firstWriteStarted = deferred();
	readonly finishFirstWrite = deferred();
	secondWriteStarted = false;

	override async writeFile(
		path: string,
		content: string | Uint8Array,
		context: Context,
	): Promise<Result<void, FileError>> {
		if (content === "first\n") {
			this.firstWriteStarted.resolve();
			await this.finishFirstWrite.promise;
		} else if (content === "second\n") {
			this.secondWriteStarted = true;
		}
		return super.writeFile(path, content, context);
	}
}

class BlockingEditExecutionEnv extends NodeExecutionEnv {
	readonly firstEditWriteStarted = deferred();
	readonly finishFirstEditWrite = deferred();
	firstEditWriteSettled = false;
	secondEditWriteStarted = false;

	override async writeFile(
		path: string,
		content: string | Uint8Array,
		context: Context,
	): Promise<Result<void, FileError>> {
		if (content === "ALPHA\nbeta\n") {
			this.firstEditWriteStarted.resolve();
			await this.finishFirstEditWrite.promise;
			const result = await super.writeFile(path, content, BACKGROUND_CONTEXT);
			this.firstEditWriteSettled = true;
			return result;
		}
		if (content === "ALPHA\nBETA\n" || content === "alpha\nBETA\n") {
			this.secondEditWriteStarted = true;
		}
		return super.writeFile(path, content, context);
	}
}

const TRUNCATED_OUTPUT_LINES = DEFAULT_MAX_LINES + 1;

class TimeoutOutputExecutionEnv extends NodeExecutionEnv {
	override async exec(
		_command: string,
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const output = `${Array.from({ length: TRUNCATED_OUTPUT_LINES }, (_, index) => `line-${index + 1}`).join("\n")}\n`;
		const spillPath = getOrThrow(await this.createTempFile({ prefix: "timeout-", suffix: ".log" }, context));
		getOrThrow(await this.writeFile(spillPath, output, context));
		options?.onOutput?.(output, context);
		const error = new ExecutionError("timeout", `timeout:${options?.timeout}`);
		error.spillPath = spillPath;
		return err(error);
	}
}

describe("durable tools", () => {
	it("fail with an ordinary error when no environment is configured", async () => {
		await expect(run(createReadTool(), { path: "x" }, undefined)).rejects.toThrow("No execution environment");
	});

	describe("read", () => {
		it.each(["GIF87a", "GIF89a"])("detects the complete %s signature", (signature) => {
			expect(detectSupportedImageMimeType(Buffer.from(signature, "ascii"))).toBe("image/gif");
		});

		it("reads text with offsets and limits and reports continuation as a diagnostic", async () => {
			const env = createEnv();
			getOrThrow(
				await env.writeFile(
					"test.txt",
					Array.from({ length: 100 }, (_, index) => `Line ${index + 1}`).join("\n"),
					BACKGROUND_CONTEXT,
				),
			);
			const result = await run(createReadTool(), { path: "test.txt", offset: 41, limit: 20 }, env);
			const output = textOutput(result);
			expect(output).not.toContain("Line 40");
			expect(output).toContain("Line 41");
			expect(output).toContain("Line 60");
			expect(output).not.toContain("Line 61");
			expect(output).not.toContain("more lines");
			expect(diagnosticText(result)).toBe("40 more lines in file. Use offset=61 to continue.");
		});

		it("truncates large text by line count", async () => {
			const env = createEnv();
			getOrThrow(
				await env.writeFile(
					"large.txt",
					Array.from({ length: 2500 }, (_, index) => `Line ${index + 1}`).join("\n"),
					BACKGROUND_CONTEXT,
				),
			);
			const result = await run(createReadTool(), { path: "large.txt" }, env);
			expect(diagnosticText(result)).toBe("Showing lines 1-2000 of 2500. Use offset=2001 to continue.");
			expect(result.diagnostics?.[0]?.code).toBe("truncated");
			expect((result.details as { truncation?: unknown } | undefined)?.truncation).toMatchObject({
				truncated: true,
				truncatedBy: "lines",
				totalLines: 2500,
				outputLines: 2000,
			});
		});

		it("does not count a trailing newline as an extra line at the truncation limit", async () => {
			const env = createEnv();
			getOrThrow(
				await env.writeFile(
					"exact.txt",
					`${Array.from({ length: 2000 }, () => "x").join("\n")}\n`,
					BACKGROUND_CONTEXT,
				),
			);
			const result = await run(createReadTool(), { path: "exact.txt" }, env);
			expect(result.details).toBeUndefined();
			expect(result.diagnostics).toEqual([]);
		});

		it("shows the start of a line longer than the byte limit", async () => {
			const env = createEnv();
			getOrThrow(await env.writeFile("long.txt", `${"é".repeat(40_000)}\nnext\n`, BACKGROUND_CONTEXT));
			const result = await run(createReadTool(), { path: "long.txt" }, env);
			const text = textOutput(result);
			// Two-byte characters: the cut lands on a character boundary at or below the limit.
			expect(text).toBe("é".repeat(25_600));
			expect(diagnosticText(result)).toBe(
				"Line 1 is 78.1KB, exceeds the 50.0KB limit; showing its first 50.0KB. Use bash: sed -n '1p' long.txt | tail -c +51201",
			);
			expect((result.details as { truncation: object }).truncation).toMatchObject({
				truncated: true,
				firstLineExceedsLimit: true,
				outputBytes: 51_200,
				outputLines: 1,
			});
			expect(result.details).not.toHaveProperty("truncation.content");
		});

		it("rejects offsets beyond the file", async () => {
			const env = createEnv();
			getOrThrow(await env.writeFile("short.txt", "one\ntwo\nthree", BACKGROUND_CONTEXT));
			await expect(run(createReadTool(), { path: "short.txt", offset: 100 }, env)).rejects.toThrow(
				"Offset 100 is beyond end of file (3 lines total)",
			);
		});

		it("reports images by content as unsupported", async () => {
			const env = createEnv();
			const png = Uint8Array.from(
				Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
					"base64",
				),
			);
			getOrThrow(await env.writeFile("image.txt", png, BACKGROUND_CONTEXT));
			const result = await run(createReadTool(), { path: "image.txt" }, env);
			expect(result).toMatchObject({ content: [], isError: true });
			expect(diagnosticText(result)).toBe("image.txt is an image (image/png); reading images is not supported");
		});
	});

	describe("write", () => {
		it("writes files and creates parent directories", async () => {
			const env = createEnv();
			const result = await run(createWriteTool(), { path: "nested/dir/file.txt", content: "hello" }, env);
			expect(textOutput(result)).toBe("Successfully wrote to nested/dir/file.txt");
			expect(getOrThrow(await env.readTextFile("nested/dir/file.txt", BACKGROUND_CONTEXT))).toBe("hello");
		});

		it("keeps the mutation queue locked until an aborted write settles", async () => {
			const env = new BlockingWriteExecutionEnv({ cwd: createTempDir() });
			const tool = createWriteTool();
			const controller = new AbortController();
			const firstWrite = run(
				tool,
				{ path: "file.txt", content: "first\n" },
				env,
				withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
			);
			await env.firstWriteStarted.promise;
			controller.abort();
			const secondWrite = run(tool, { path: "file.txt", content: "second\n" }, env);
			await delay(20);
			expect(env.secondWriteStarted).toBe(false);
			env.finishFirstWrite.resolve();
			await expect(firstWrite).rejects.toThrow();
			await secondWrite;
			expect(getOrThrow(await env.readTextFile("file.txt", BACKGROUND_CONTEXT))).toBe("second\n");
		});
	});

	describe("edit", () => {
		it("applies disjoint edits and returns both diff formats", async () => {
			const env = createEnv();
			const original = "alpha\nbeta\ngamma\ndelta\n";
			getOrThrow(await env.writeFile("edit.txt", original, BACKGROUND_CONTEXT));
			const result = await run(
				createEditTool(),
				{
					path: "edit.txt",
					edits: [
						{ oldText: "alpha\n", newText: "ALPHA\n" },
						{ oldText: "gamma\n", newText: "GAMMA\n" },
					],
				},
				env,
			);
			const details = result.details as { diff: string; patch: string };
			expect(textOutput(result)).toBe("Successfully replaced 2 block(s) in edit.txt.");
			expect(details.diff).toContain("ALPHA");
			expect(details.diff).toContain("GAMMA");
			expect(applyPatch(original, details.patch)).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
			expect(getOrThrow(await env.readTextFile("edit.txt", BACKGROUND_CONTEXT))).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
		});

		it("repairs edits sent as a JSON string, a single object, or top-level oldText/newText without mutating them", () => {
			const prepare = createEditTool().prepareArguments!;
			const edit = { oldText: "a", newText: "b" };
			const asString = { path: "f", edits: JSON.stringify([edit]) };
			expect(prepare(asString)).toEqual({ path: "f", edits: [edit] });
			expect(asString.edits).toBe(JSON.stringify([edit]));
			expect(prepare({ path: "f", edits: JSON.stringify(edit) })).toEqual({ path: "f", edits: [edit] });
			expect(prepare({ path: "f", edits: edit })).toEqual({ path: "f", edits: [edit] });
			expect(prepare({ path: "f", edits: [edit], oldText: "c", newText: "d" })).toEqual({
				path: "f",
				edits: [edit, { oldText: "c", newText: "d" }],
			});
			expect(prepare({ path: "f", edits: "not json" })).toEqual({ path: "f", edits: "not json" });
		});

		it("matches all edits against the original and rejects overlaps", async () => {
			const env = createEnv();
			getOrThrow(await env.writeFile("edit.txt", "one\ntwo\nthree\n", BACKGROUND_CONTEXT));
			await expect(
				run(
					createEditTool(),
					{
						path: "edit.txt",
						edits: [
							{ oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
							{ oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
						],
					},
					env,
				),
			).rejects.toThrow(/overlap/);
			expect(getOrThrow(await env.readTextFile("edit.txt", BACKGROUND_CONTEXT))).toBe("one\ntwo\nthree\n");
		});

		it("rejects missing and duplicate target text", async () => {
			const env = createEnv();
			getOrThrow(await env.writeFile("edit.txt", "foo foo foo", BACKGROUND_CONTEXT));
			const tool = createEditTool();
			await expect(
				run(tool, { path: "edit.txt", edits: [{ oldText: "bar", newText: "baz" }] }, env),
			).rejects.toThrow(/Could not find the exact text/);
			await expect(
				run(tool, { path: "edit.txt", edits: [{ oldText: "foo", newText: "bar" }] }, env),
			).rejects.toThrow(/Found 3 occurrences/);
		});

		it("keeps the mutation queue locked until an aborted edit write settles", async () => {
			const env = new BlockingEditExecutionEnv({ cwd: createTempDir() });
			getOrThrow(await env.writeFile("file.txt", "alpha\nbeta\n", BACKGROUND_CONTEXT));
			const tool = createEditTool();
			const controller = new AbortController();
			const firstEdit = run(
				tool,
				{ path: "file.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
				env,
				withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
			);
			await env.firstEditWriteStarted.promise;
			controller.abort();
			const secondEdit = run(tool, { path: "file.txt", edits: [{ oldText: "beta", newText: "BETA" }] }, env);
			await delay(20);
			expect(env.secondEditWriteStarted).toBe(false);
			env.finishFirstEditWrite.resolve();
			await expect(firstEdit).rejects.toThrow("Operation aborted");
			await secondEdit;
			expect(env.firstEditWriteSettled).toBe(true);
			expect(getOrThrow(await env.readTextFile("file.txt", BACKGROUND_CONTEXT))).toBe("ALPHA\nBETA\n");
		});

		it("serializes concurrent edits through canonical and symlink paths", async () => {
			const env = new SlowReadExecutionEnv({ cwd: createTempDir() });
			getOrThrow(await env.writeFile("target.txt", "alpha\nbeta\ngamma\n", BACKGROUND_CONTEXT));
			await symlink("target.txt", `${env.cwd}/link.txt`);
			const tool = createEditTool();
			await Promise.all([
				run(tool, { path: "target.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] }, env),
				run(tool, { path: "link.txt", edits: [{ oldText: "beta", newText: "BETA" }] }, env),
			]);
			expect(getOrThrow(await env.readTextFile("target.txt", BACKGROUND_CONTEXT))).toBe("ALPHA\nBETA\ngamma\n");
		});

		it("serializes edits of one file across environment objects of one file system", async () => {
			const dir = createTempDir();
			const first = new SlowReadExecutionEnv({ cwd: dir });
			const second = new SlowReadExecutionEnv({ cwd: dir });
			getOrThrow(await first.writeFile("file.txt", "alpha\nbeta\n", BACKGROUND_CONTEXT));
			const tool = createEditTool();
			await Promise.all([
				run(tool, { path: "file.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] }, first),
				run(tool, { path: "file.txt", edits: [{ oldText: "beta", newText: "BETA" }] }, second),
			]);
			expect(getOrThrow(await first.readTextFile("file.txt", BACKGROUND_CONTEXT))).toBe("ALPHA\nBETA\n");
		});

		it("serializes a new file created through a symlinked directory with its canonical path", async () => {
			const env = new BlockingWriteExecutionEnv({ cwd: createTempDir() });
			mkdirSync(`${env.cwd}/real`);
			await symlink(`${env.cwd}/real`, `${env.cwd}/link`);
			const tool = createWriteTool();
			const first = run(tool, { path: "link/new.txt", content: "first\n" }, env);
			await env.firstWriteStarted.promise;
			const second = run(tool, { path: "real/new.txt", content: "second\n" }, env);
			await delay(20);
			expect(env.secondWriteStarted).toBe(false);
			env.finishFirstWrite.resolve();
			await Promise.all([first, second]);
			expect(getOrThrow(await env.readTextFile("real/new.txt", BACKGROUND_CONTEXT))).toBe("second\n");
		});

		it.skipIf(process.platform === "win32")(
			"keys a missing file whose name contains a backslash like the created file",
			async () => {
				const env = createEnv();
				const created = deferred();
				const release = deferred();
				const first = withFileMutationQueue(
					env,
					"a\\b.txt",
					async () => {
						getOrThrow(await env.writeFile("a\\b.txt", "first\n", BACKGROUND_CONTEXT));
						created.resolve();
						await release.promise;
					},
					BACKGROUND_CONTEXT,
				);
				await created.promise;
				let entered = false;
				const second = withFileMutationQueue(
					env,
					"a\\b.txt",
					async () => {
						entered = true;
					},
					BACKGROUND_CONTEXT,
				);
				await delay(20);
				expect(entered).toBe(false);
				release.resolve();
				await Promise.all([first, second]);
				expect(entered).toBe(true);
			},
		);

		it("does not serialize the same path on different file systems", async () => {
			class OtherFileSystem extends BlockingWriteExecutionEnv {
				override readonly id = "other";
			}
			const dir = createTempDir();
			const local = new BlockingWriteExecutionEnv({ cwd: dir });
			const other = new OtherFileSystem({ cwd: dir });
			const tool = createWriteTool();
			const blocked = run(tool, { path: "file.txt", content: "first\n" }, local);
			await local.firstWriteStarted.promise;
			await run(tool, { path: "file.txt", content: "second\n" }, other);
			expect(other.secondWriteStarted).toBe(true);
			local.finishFirstWrite.resolve();
			await blocked;
		});

		it("edits regular files through symlinks", async () => {
			const env = createEnv();
			getOrThrow(await env.writeFile("target.txt", "before\n", BACKGROUND_CONTEXT));
			await symlink("target.txt", `${env.cwd}/link.txt`);
			await run(createEditTool(), { path: "link.txt", edits: [{ oldText: "before", newText: "after" }] }, env);
			expect(getOrThrow(await env.readTextFile("target.txt", BACKGROUND_CONTEXT))).toBe("after\n");
		});

		it("preserves BOM and CRLF line endings", async () => {
			const env = createEnv();
			getOrThrow(await env.writeFile("edit.txt", "\uFEFFone\r\ntwo\r\n", BACKGROUND_CONTEXT));
			await run(createEditTool(), { path: "edit.txt", edits: [{ oldText: "two", newText: "TWO" }] }, env);
			expect(getOrThrow(await env.readTextFile("edit.txt", BACKGROUND_CONTEXT))).toBe("\uFEFFone\r\nTWO\r\n");
		});
	});

	describe("bash", () => {
		it("streams combined stdout and stderr and returns no content of its own", async () => {
			const result = await run(createBashTool(), { command: "printf out; printf err >&2" }, createEnv());
			expect(result.output.join("")).toContain("out");
			expect(result.output.join("")).toContain("err");
			expect(result.content).toBeUndefined();
		});

		it("throws on nonzero exits and timeouts after streaming the output", async () => {
			const env = createEnv();
			const tool = createBashTool();
			const failed = await runFailing(tool, { command: "printf failed; exit 7" }, env);
			expect(failed.error.message).toBe("Command exited with code 7");
			expect(failed.output.join("")).toBe("failed");
			const slow = await runFailing(tool, { command: "sleep 2", timeout: 0.01 }, env);
			expect(slow.error.message).toBe("Command timed out after 0.01 seconds");
		});

		it("reports the spill of a command that times out", async () => {
			const env = new TimeoutOutputExecutionEnv({ cwd: createTempDir() });
			const failed = await runFailing(
				createBashTool(),
				{ command: "emit-output-then-time-out", timeout: 0.05 },
				env,
			);
			expect(failed.error.message).toBe("Command timed out after 0.05 seconds");
			const fullOutputPath = failed.reported[0]?.message.match(/^Full output: (.+)$/)?.[1];
			expect(fullOutputPath).toBeDefined();
			const fullOutput = getOrThrow(await env.readTextFile(fullOutputPath!, BACKGROUND_CONTEXT));
			expect(fullOutput).toContain("line-1\nline-2");
			expect(fullOutput).toContain(`line-${DEFAULT_MAX_LINES}\nline-${TRUNCATED_OUTPUT_LINES}`);
		});

		it("prepares command, cwd, and an explicit environment with the call's api", async () => {
			const env = new NodeExecutionEnv({
				cwd: createTempDir(),
				shellEnv: { PI_BASH_PREPARE_INHERITED: "inherited" },
			});
			getOrThrow(await env.createDir("workspace", undefined, BACKGROUND_CONTEXT));
			const workspace = `${env.cwd}/workspace`;
			const controller = new AbortController();
			let receivedEnv: ExecutionEnv | undefined;
			let receivedSignal: AbortSignal | undefined;
			const tool = createBashTool({
				commandPrefix: "prefix=ready",
				prepare: async (execution, api, callContext) => {
					receivedEnv = api.env;
					receivedSignal = callContext.abortSignal;
					execution.cwd = workspace;
					execution.env = { PI_BASH_PREPARE_EXPLICIT: "explicit" };
					execution.inheritEnv = false;
					execution.command += `\nprintf '%s:%s:%s:%s' "$prefix" "\${PI_BASH_PREPARE_INHERITED-}" "$PI_BASH_PREPARE_EXPLICIT" "$PWD"`;
				},
			});
			const result = await run(tool, { command: ":" }, env, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
			expect(receivedEnv).toBe(env);
			expect(receivedSignal).toBe(controller.signal);
			expect(result.output.join("")).toBe(
				`ready::explicit:${getOrThrow(await env.canonicalPath(workspace, BACKGROUND_CONTEXT))}`,
			);
		});

		it("supports command prefixes", async () => {
			const result = await run(
				createBashTool({ commandPrefix: "value=hello" }),
				{ command: "printf $value" },
				createEnv(),
			);
			expect(result.output.join("")).toBe("hello");
		});

		it("streams every byte and spills complete output beyond the default limits", async () => {
			const env = createEnv();
			const result = await run(
				createBashTool(),
				{ command: "i=1; while [ $i -le 3000 ]; do echo line-$i; i=$((i + 1)); done" },
				env,
			);
			const expected = Array.from({ length: 3000 }, (_, index) => `line-${index + 1}\n`).join("");
			expect(result.output.join("")).toBe(expected);
			const fullOutputPath = result.reported[0]?.message.match(/^Full output: (.+)$/)?.[1];
			expect(fullOutputPath).toBeDefined();
			expect(getOrThrow(await env.readTextFile(fullOutputPath!, BACKGROUND_CONTEXT))).toBe(expected);
		});

		it("does not spill output within the limits", async () => {
			const result = await run(createBashTool(), { command: "printf small" }, createEnv());
			expect(result.reported).toEqual([]);
		});
	});
});
