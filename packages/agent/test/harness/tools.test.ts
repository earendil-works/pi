import { symlink } from "node:fs/promises";
import { applyPatch } from "diff";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { type BashToolDetails, createBashTool } from "../../src/harness/tools/bash.ts";
import { createEditTool } from "../../src/harness/tools/edit.ts";
import { createReadTool } from "../../src/harness/tools/read.ts";
import { createWriteTool } from "../../src/harness/tools/write.ts";
import {
	ExecutionError,
	err,
	type FileError,
	getOrThrow,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
} from "../../src/harness/types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "../../src/harness/utils/truncate.ts";
import { createTempDir } from "./session-test-utils.ts";

const noUpdate = () => {};

function textOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

function createContext() {
	const env = new NodeExecutionEnv({ cwd: createTempDir() });
	return { env };
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

function fakeShellOutput(text: string, options: ShellExecOptions | undefined, spillPath?: string): ShellExecResult {
	const limits = options?.capture?.limits ?? {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
		retain: "tail" as const,
	};
	const truncated = truncateTail(text, limits);
	const { content, ...truncation } = truncated;
	options?.onUpdate?.(
		{
			kind: "replace",
			output: { text: content, truncation, ...(spillPath === undefined ? {} : { spillPath }) },
		},
		BACKGROUND_CONTEXT,
	);
	return { exitCode: 0, truncation, ...(spillPath === undefined ? {} : { spillPath }) };
}

class LateOutputExecutionEnv extends NodeExecutionEnv {
	override async exec(
		_command: string,
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const result = fakeShellOutput("before\n", options);
		setTimeout(() => {
			const truncation = truncateTail("before\nlate\n", options?.capture?.limits);
			options?.onUpdate?.({ kind: "replace", output: { text: truncation.content, truncation } }, context);
		}, 0);
		return ok(result);
	}
}

const TRUNCATED_OUTPUT_LINES = DEFAULT_MAX_LINES + 1;
const invocation = {
	invocationId: "test-result",
	operationId: "test-operation",
	turnId: "test-turn",
	getMemo: async () => undefined,
	setMemo: async () => {},
};

class CheckpointOutputExecutionEnv extends NodeExecutionEnv {
	override async exec(
		_command: string,
		options: ShellExecOptions | undefined,
		_context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		fakeShellOutput("one\n", options);
		await delay(2_100);
		fakeShellOutput("one\ntwo\n", options);
		await delay(100);
		fakeShellOutput("one\ntwo\nthree\n", options);
		await delay(2_000);
		return ok(fakeShellOutput("one\ntwo\nthree\nfour\n", options));
	}
}

class TimeoutOutputExecutionEnv extends NodeExecutionEnv {
	override async exec(
		_command: string,
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const output = `${Array.from({ length: TRUNCATED_OUTPUT_LINES }, (_, index) => `line-${index + 1}`).join("\n")}\n`;
		const spillPath = getOrThrow(await this.createTempFile({ prefix: "timeout-", suffix: ".log" }, context));
		getOrThrow(await this.writeFile(spillPath, output, context));
		fakeShellOutput(output, options, spillPath);
		return err(new ExecutionError("timeout", `timeout:${options?.timeout}`));
	}
}

function createTinyBmp(): Uint8Array {
	const bytes = new Uint8Array(58);
	const view = new DataView(bytes.buffer);
	bytes[0] = 0x42;
	bytes[1] = 0x4d;
	view.setUint32(2, bytes.length, true);
	view.setUint32(10, 54, true);
	view.setUint32(14, 40, true);
	view.setInt32(18, 1, true);
	view.setInt32(22, 1, true);
	view.setUint16(26, 1, true);
	view.setUint16(28, 24, true);
	view.setUint32(34, 4, true);
	return bytes;
}

describe("AgentHarness tools", () => {
	describe("read", () => {
		it("reads text with offsets, limits, and continuation notices", async () => {
			const context = createContext();
			getOrThrow(
				await context.env.writeFile(
					"test.txt",
					Array.from({ length: 100 }, (_, index) => `Line ${index + 1}`).join("\n"),
					BACKGROUND_CONTEXT,
				),
			);

			const result = await createReadTool().execute(
				"read-1",
				{ path: "test.txt", offset: 41, limit: 20 },
				noUpdate,
				context,
				invocation,
				BACKGROUND_CONTEXT,
			);
			const output = textOutput(result);

			expect(output).not.toContain("Line 40");
			expect(output).toContain("Line 41");
			expect(output).toContain("Line 60");
			expect(output).not.toContain("Line 61");
			expect(output).toContain("[40 more lines in file. Use offset=61 to continue.]");
		});

		it("truncates large text by line count", async () => {
			const context = createContext();
			getOrThrow(
				await context.env.writeFile(
					"large.txt",
					Array.from({ length: 2500 }, (_, index) => `Line ${index + 1}`).join("\n"),
					BACKGROUND_CONTEXT,
				),
			);

			const result = await createReadTool().execute(
				"read-2",
				{ path: "large.txt" },
				noUpdate,
				context,
				invocation,
				BACKGROUND_CONTEXT,
			);

			expect(textOutput(result)).toContain("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]");
			expect(result.details?.truncation).toMatchObject({
				truncated: true,
				truncatedBy: "lines",
				totalLines: 2500,
				outputLines: 2000,
			});
		});

		it("does not count a trailing newline as an extra line at the truncation limit", async () => {
			const context = createContext();
			getOrThrow(
				await context.env.writeFile(
					"exact.txt",
					`${Array.from({ length: 2000 }, () => "x").join("\n")}\n`,
					BACKGROUND_CONTEXT,
				),
			);

			const result = await createReadTool().execute(
				"read-exact",
				{ path: "exact.txt" },
				noUpdate,
				context,
				invocation,
				BACKGROUND_CONTEXT,
			);

			expect(result.details).toBeUndefined();
			expect(textOutput(result)).not.toContain("Use offset=");
		});

		it("rejects offsets beyond the file", async () => {
			const context = createContext();
			getOrThrow(await context.env.writeFile("short.txt", "one\ntwo\nthree", BACKGROUND_CONTEXT));

			await expect(
				createReadTool().execute(
					"read-3",
					{ path: "short.txt", offset: 100 },
					noUpdate,
					context,
					invocation,
					BACKGROUND_CONTEXT,
				),
			).rejects.toThrow("Offset 100 is beyond end of file (3 lines total)");
		});

		it("detects supported images by content", async () => {
			const context = createContext();
			const png = Uint8Array.from(
				Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
					"base64",
				),
			);
			getOrThrow(await context.env.writeFile("image.txt", png, BACKGROUND_CONTEXT));

			const result = await createReadTool().execute(
				"read-4",
				{ path: "image.txt" },
				noUpdate,
				context,
				invocation,
				BACKGROUND_CONTEXT,
			);

			expect(textOutput(result)).toContain("Read image file [image/png]");
			expect(result.content).toContainEqual({
				type: "image",
				data: Buffer.from(png).toString("base64"),
				mimeType: "image/png",
			});
		});

		it("delegates image conversion and resizing to an injected processor", async () => {
			const context = createContext();
			const bmp = createTinyBmp();
			getOrThrow(await context.env.writeFile("image.bmp", bmp, BACKGROUND_CONTEXT));
			let received: { bytes: Uint8Array; mimeType: string; autoResizeImages: boolean } | undefined;
			const tool = createReadTool({
				autoResizeImages: false,
				imageProcessor: async (bytes, mimeType, options) => {
					received = { bytes, mimeType, autoResizeImages: options.autoResizeImages };
					return {
						ok: true,
						data: "converted",
						mimeType: "image/png",
						hints: ["[Image converted from image/bmp to image/png.]"],
					};
				},
			});

			const result = await tool.execute(
				"read-bmp",
				{ path: "image.bmp" },
				noUpdate,
				context,
				invocation,
				BACKGROUND_CONTEXT,
			);

			expect(received).toMatchObject({ mimeType: "image/bmp", autoResizeImages: false });
			expect(Array.from(received?.bytes ?? [])).toEqual(Array.from(bmp));
			expect(textOutput(result)).toContain("[Image converted from image/bmp to image/png.]");
			expect(result.content).toContainEqual({ type: "image", data: "converted", mimeType: "image/png" });
		});
	});

	describe("write", () => {
		it("writes files and creates parent directories", async () => {
			const context = createContext();
			const result = await createWriteTool().execute(
				"write-1",
				{ path: "nested/dir/file.txt", content: "hello" },
				noUpdate,
				context,
				invocation,
				BACKGROUND_CONTEXT,
			);

			expect(textOutput(result)).toBe("Successfully wrote to nested/dir/file.txt");
			expect(getOrThrow(await context.env.readTextFile("nested/dir/file.txt", BACKGROUND_CONTEXT))).toBe("hello");
		});

		it("keeps the mutation queue locked until an aborted write settles", async () => {
			const env = new BlockingWriteExecutionEnv({ cwd: createTempDir() });
			const tool = createWriteTool();
			const controller = new AbortController();
			const firstWrite = tool.execute(
				"write-first",
				{ path: "file.txt", content: "first\n" },
				noUpdate,
				{
					env,
				},
				invocation,
				withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
			);
			await env.firstWriteStarted.promise;
			controller.abort();
			const secondWrite = tool.execute(
				"write-second",
				{ path: "file.txt", content: "second\n" },
				noUpdate,
				{ env },
				invocation,
				BACKGROUND_CONTEXT,
			);

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
			const context = createContext();
			const original = "alpha\nbeta\ngamma\ndelta\n";
			getOrThrow(await context.env.writeFile("edit.txt", original, BACKGROUND_CONTEXT));

			const result = await createEditTool().execute(
				"edit-1",
				{
					path: "edit.txt",
					edits: [
						{ oldText: "alpha\n", newText: "ALPHA\n" },
						{ oldText: "gamma\n", newText: "GAMMA\n" },
					],
				},
				noUpdate,
				context,
				invocation,
				BACKGROUND_CONTEXT,
			);

			expect(textOutput(result)).toBe("Successfully replaced 2 block(s) in edit.txt.");
			expect(result.details?.diff).toContain("ALPHA");
			expect(result.details?.diff).toContain("GAMMA");
			expect(applyPatch(original, result.details?.patch ?? "")).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
			expect(getOrThrow(await context.env.readTextFile("edit.txt", BACKGROUND_CONTEXT))).toBe(
				"ALPHA\nbeta\nGAMMA\ndelta\n",
			);
		});

		it("matches all edits against the original and rejects overlaps", async () => {
			const context = createContext();
			getOrThrow(await context.env.writeFile("edit.txt", "one\ntwo\nthree\n", BACKGROUND_CONTEXT));

			await expect(
				createEditTool().execute(
					"edit-2",
					{
						path: "edit.txt",
						edits: [
							{ oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
							{ oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
						],
					},
					noUpdate,
					context,
					invocation,
					BACKGROUND_CONTEXT,
				),
			).rejects.toThrow(/overlap/);
			expect(getOrThrow(await context.env.readTextFile("edit.txt", BACKGROUND_CONTEXT))).toBe("one\ntwo\nthree\n");
		});

		it("rejects missing and duplicate target text", async () => {
			const context = createContext();
			getOrThrow(await context.env.writeFile("edit.txt", "foo foo foo", BACKGROUND_CONTEXT));
			const tool = createEditTool();

			await expect(
				tool.execute(
					"edit-3",
					{ path: "edit.txt", edits: [{ oldText: "bar", newText: "baz" }] },
					noUpdate,
					context,
					invocation,
					BACKGROUND_CONTEXT,
				),
			).rejects.toThrow(/Could not find the exact text/);
			await expect(
				tool.execute(
					"edit-4",
					{ path: "edit.txt", edits: [{ oldText: "foo", newText: "bar" }] },
					noUpdate,
					context,
					invocation,
					BACKGROUND_CONTEXT,
				),
			).rejects.toThrow(/Found 3 occurrences/);
		});

		it("keeps the mutation queue locked until an aborted edit write settles", async () => {
			const env = new BlockingEditExecutionEnv({ cwd: createTempDir() });
			getOrThrow(await env.writeFile("file.txt", "alpha\nbeta\n", BACKGROUND_CONTEXT));
			const tool = createEditTool();
			const controller = new AbortController();
			const firstEdit = tool.execute(
				"edit-first",
				{ path: "file.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
				noUpdate,
				{ env },
				invocation,
				withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
			);
			await env.firstEditWriteStarted.promise;
			controller.abort();
			const secondEdit = tool.execute(
				"edit-second",
				{ path: "file.txt", edits: [{ oldText: "beta", newText: "BETA" }] },
				noUpdate,
				{ env },
				invocation,
				BACKGROUND_CONTEXT,
			);

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
				tool.execute(
					"edit-target",
					{ path: "target.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
					noUpdate,
					{ env },
					invocation,
					BACKGROUND_CONTEXT,
				),
				tool.execute(
					"edit-link",
					{ path: "link.txt", edits: [{ oldText: "beta", newText: "BETA" }] },
					noUpdate,
					{ env },
					invocation,
					BACKGROUND_CONTEXT,
				),
			]);

			expect(getOrThrow(await env.readTextFile("target.txt", BACKGROUND_CONTEXT))).toBe("ALPHA\nBETA\ngamma\n");
		});

		it("edits regular files through symlinks", async () => {
			const context = createContext();
			getOrThrow(await context.env.writeFile("target.txt", "before\n", BACKGROUND_CONTEXT));
			await symlink("target.txt", `${context.env.cwd}/link.txt`);

			await createEditTool().execute(
				"edit-symlink",
				{ path: "link.txt", edits: [{ oldText: "before", newText: "after" }] },
				noUpdate,
				context,
				invocation,
				BACKGROUND_CONTEXT,
			);

			expect(getOrThrow(await context.env.readTextFile("target.txt", BACKGROUND_CONTEXT))).toBe("after\n");
		});

		it("preserves BOM and CRLF line endings", async () => {
			const context = createContext();
			getOrThrow(await context.env.writeFile("edit.txt", "\uFEFFone\r\ntwo\r\n", BACKGROUND_CONTEXT));

			await createEditTool().execute(
				"edit-5",
				{ path: "edit.txt", edits: [{ oldText: "two", newText: "TWO" }] },
				noUpdate,
				context,
				invocation,
				BACKGROUND_CONTEXT,
			);

			expect(getOrThrow(await context.env.readTextFile("edit.txt", BACKGROUND_CONTEXT))).toBe(
				"\uFEFFone\r\nTWO\r\n",
			);
		});
	});

	describe("bash", () => {
		it("executes commands and combines stdout and stderr", async () => {
			const context = createContext();
			const result = await createBashTool().execute(
				"bash-1",
				{ command: "printf out; printf err >&2" },
				noUpdate,
				context,
				invocation,
				BACKGROUND_CONTEXT,
			);

			expect(textOutput(result)).toContain("out");
			expect(textOutput(result)).toContain("err");
		});

		it("reports nonzero exits and timeouts", async () => {
			const context = createContext();
			const tool = createBashTool();

			await expect(
				tool.execute(
					"bash-2",
					{ command: "printf failed; exit 7" },
					noUpdate,
					context,
					invocation,
					BACKGROUND_CONTEXT,
				),
			).rejects.toThrow(/failed[\s\S]*Command exited with code 7/);
			await expect(
				tool.execute(
					"bash-3",
					{ command: "sleep 2", timeout: 0.01 },
					noUpdate,
					context,
					invocation,
					BACKGROUND_CONTEXT,
				),
			).rejects.toThrow(/Command timed out after 0.01 seconds/);
		});

		it("preserves truncated output when a command times out", async () => {
			const context = { env: new TimeoutOutputExecutionEnv({ cwd: createTempDir() }) };
			let error: unknown;
			try {
				await createBashTool().execute(
					"bash-timeout-output",
					{ command: "emit-output-then-time-out", timeout: 0.05 },
					noUpdate,
					context,
					invocation,
					BACKGROUND_CONTEXT,
				);
			} catch (cause) {
				error = cause;
			}

			expect(error).toBeInstanceOf(Error);
			const message = (error as Error).message;
			expect(message).toContain("Command timed out after 0.05 seconds");
			const fullOutputPath = message.match(/Full output: ([^\]\n]+)/)?.[1];
			expect(fullOutputPath).toBeDefined();
			const fullOutput = getOrThrow(await context.env.readTextFile(fullOutputPath!, BACKGROUND_CONTEXT));
			expect(fullOutput).toContain("line-1\nline-2");
			expect(fullOutput).toContain(`line-${DEFAULT_MAX_LINES}\nline-${TRUNCATED_OUTPUT_LINES}`);
		});

		it("ignores output callbacks after execution settles", async () => {
			const env = new LateOutputExecutionEnv({ cwd: createTempDir() });
			const updates: string[] = [];
			const result = await createBashTool().execute(
				"bash-late",
				{ command: "late" },
				(update) => updates.push(textOutput(update)),
				{ env },
				invocation,
				BACKGROUND_CONTEXT,
			);
			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(textOutput(result)).toBe("before\n");
			expect(updates.some((update) => update.includes("late"))).toBe(false);
		});

		it("reports the total size of an oversized final line", async () => {
			const context = createContext();
			const result = await createBashTool().execute(
				"bash-long-line",
				{ command: "printf '%060000d' 0" },
				noUpdate,
				context,
				invocation,
				BACKGROUND_CONTEXT,
			);

			expect(textOutput(result)).toMatch(/Showing last 50\.0KB of line 1 \(line is 58\.6KB\)\. Full output:/);
		});

		it("prepares command, cwd, and an explicit environment with the turn context", async () => {
			const env = new NodeExecutionEnv({
				cwd: createTempDir(),
				shellEnv: { PI_BASH_PREPARE_INHERITED: "inherited" },
			});
			getOrThrow(await env.createDir("workspace", undefined, BACKGROUND_CONTEXT));
			const context = { env, workspace: `${env.cwd}/workspace` };
			const controller = new AbortController();
			let receivedContext: typeof context | undefined;
			let receivedSignal: AbortSignal | undefined;
			const tool = createBashTool<typeof context>({
				commandPrefix: "prefix=ready",
				prepare: async (execution, turnContext, callContext) => {
					receivedContext = turnContext;
					receivedSignal = callContext.abortSignal;
					execution.cwd = turnContext.workspace;
					execution.env = { PI_BASH_PREPARE_EXPLICIT: "explicit" };
					execution.inheritEnv = false;
					execution.command += `\nprintf '%s:%s:%s:%s' "$prefix" "\${PI_BASH_PREPARE_INHERITED-}" "$PI_BASH_PREPARE_EXPLICIT" "$PWD"`;
				},
			});

			const result = await tool.execute(
				"bash-prepare",
				{ command: ":" },
				noUpdate,
				context,
				invocation,
				withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
			);

			expect(receivedContext).toBe(context);
			expect(receivedSignal).toBe(controller.signal);
			expect(textOutput(result)).toBe(
				`ready::explicit:${getOrThrow(await env.canonicalPath(context.workspace, BACKGROUND_CONTEXT))}`,
			);
		});

		it("supports command prefixes", async () => {
			const context = createContext();
			const result = await createBashTool({ commandPrefix: "value=hello" }).execute(
				"bash-4",
				{ command: "printf $value" },
				noUpdate,
				context,
				invocation,
				BACKGROUND_CONTEXT,
			);

			expect(textOutput(result)).toBe("hello");
		});

		it("requests distinct bounded checkpoints at most every two seconds", async () => {
			vi.useFakeTimers({ now: 0 });
			try {
				const env = new CheckpointOutputExecutionEnv({ cwd: createTempDir() });
				const checkpoints: string[] = [];
				const execution = createBashTool().execute(
					"bash-checkpoints",
					{ command: "controlled" },
					(update, options) => {
						if (options?.checkpoint === true) checkpoints.push(textOutput(update));
					},
					{ env },
					invocation,
					BACKGROUND_CONTEXT,
				);
				await vi.advanceTimersByTimeAsync(4_500);
				await execution;

				expect(checkpoints).toEqual(["one\ntwo\n", "one\ntwo\nthree\nfour\n"]);
			} finally {
				vi.useRealTimers();
			}
		});

		it("coalesces updates and persists truncated full output", async () => {
			const context = createContext();
			const updates: Array<{
				content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
				details?: BashToolDetails;
			}> = [];
			const result = await createBashTool().execute(
				"bash-5",
				{ command: "i=1; while [ $i -le 3000 ]; do echo line-$i; i=$((i + 1)); done" },
				(update) => updates.push(update),
				context,
				invocation,
				BACKGROUND_CONTEXT,
			);

			expect(updates.length).toBeLessThan(25);
			expect(result.details?.truncation).toMatchObject({
				truncated: true,
				truncatedBy: "lines",
				totalLines: 3000,
				outputLines: 2000,
			});
			expect(textOutput(result)).toContain("line-3000");
			expect(result.details?.fullOutputPath).toBeDefined();
			const finalUpdate = updates.at(-1);
			expect(finalUpdate ? textOutput(finalUpdate) : "").toContain("line-3000");
			expect(finalUpdate?.details).toMatchObject({
				truncation: { totalLines: 3000, totalBytes: expect.any(Number) },
				fullOutputPath: result.details?.fullOutputPath,
			});
			const fullOutput = getOrThrow(
				await context.env.readTextFile(result.details!.fullOutputPath!, BACKGROUND_CONTEXT),
			);
			expect(fullOutput).toContain("line-1\nline-2");
			expect(fullOutput).toContain("line-2999\nline-3000");
		});
	});
});
