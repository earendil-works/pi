import { symlink } from "node:fs/promises";
import { applyPatch } from "diff";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { type BashToolDetails, createBashTool } from "../../src/harness/tools/bash.ts";
import { createEditTool } from "../../src/harness/tools/edit.ts";
import { createReadTool } from "../../src/harness/tools/read.ts";
import { createWriteTool } from "../../src/harness/tools/write.ts";
import {
	type ExecutionError,
	type FileError,
	getOrThrow,
	ok,
	type Result,
	type ShellExecOptions,
} from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

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
	override async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		await delay(20);
		return super.readTextFile(path, abortSignal);
	}
}

class BlockingWriteExecutionEnv extends NodeExecutionEnv {
	readonly firstWriteStarted = deferred();
	readonly finishFirstWrite = deferred();
	secondWriteStarted = false;

	override async writeFile(
		path: string,
		content: string | Uint8Array,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		if (content === "first\n") {
			this.firstWriteStarted.resolve();
			await this.finishFirstWrite.promise;
		} else if (content === "second\n") {
			this.secondWriteStarted = true;
		}
		return super.writeFile(path, content, abortSignal);
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
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		if (content === "ALPHA\nbeta\n") {
			this.firstEditWriteStarted.resolve();
			await this.finishFirstEditWrite.promise;
			const result = await super.writeFile(path, content);
			this.firstEditWriteSettled = true;
			return result;
		}
		if (content === "ALPHA\nBETA\n" || content === "alpha\nBETA\n") {
			this.secondEditWriteStarted = true;
		}
		return super.writeFile(path, content, abortSignal);
	}
}

class LateOutputExecutionEnv extends NodeExecutionEnv {
	override async exec(
		_command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		options?.onStdout?.("before\n");
		setTimeout(() => options?.onStdout?.("late\n"), 0);
		return ok({ stdout: "before\n", stderr: "", exitCode: 0 });
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
				),
			);

			const result = await createReadTool().execute(
				"read-1",
				{ path: "test.txt", offset: 41, limit: 20 },
				undefined,
				undefined,
				context,
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
				),
			);

			const result = await createReadTool().execute("read-2", { path: "large.txt" }, undefined, undefined, context);

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
				await context.env.writeFile("exact.txt", `${Array.from({ length: 2000 }, () => "x").join("\n")}\n`),
			);

			const result = await createReadTool().execute(
				"read-exact",
				{ path: "exact.txt" },
				undefined,
				undefined,
				context,
			);

			expect(result.details).toBeUndefined();
			expect(textOutput(result)).not.toContain("Use offset=");
		});

		it("rejects offsets beyond the file", async () => {
			const context = createContext();
			getOrThrow(await context.env.writeFile("short.txt", "one\ntwo\nthree"));

			await expect(
				createReadTool().execute("read-3", { path: "short.txt", offset: 100 }, undefined, undefined, context),
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
			getOrThrow(await context.env.writeFile("image.txt", png));

			const result = await createReadTool().execute("read-4", { path: "image.txt" }, undefined, undefined, context);

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
			getOrThrow(await context.env.writeFile("image.bmp", bmp));
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

			const result = await tool.execute("read-bmp", { path: "image.bmp" }, undefined, undefined, context);

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
				undefined,
				undefined,
				context,
			);

			expect(textOutput(result)).toBe("Successfully wrote 5 bytes to nested/dir/file.txt");
			expect(getOrThrow(await context.env.readTextFile("nested/dir/file.txt"))).toBe("hello");
		});

		it("keeps the mutation queue locked until an aborted write settles", async () => {
			const env = new BlockingWriteExecutionEnv({ cwd: createTempDir() });
			const tool = createWriteTool();
			const controller = new AbortController();
			const firstWrite = tool.execute(
				"write-first",
				{ path: "file.txt", content: "first\n" },
				controller.signal,
				undefined,
				{
					env,
				},
			);
			await env.firstWriteStarted.promise;
			controller.abort();
			const secondWrite = tool.execute(
				"write-second",
				{ path: "file.txt", content: "second\n" },
				undefined,
				undefined,
				{ env },
			);

			await delay(20);
			expect(env.secondWriteStarted).toBe(false);
			env.finishFirstWrite.resolve();
			await expect(firstWrite).rejects.toThrow();
			await secondWrite;
			expect(getOrThrow(await env.readTextFile("file.txt"))).toBe("second\n");
		});
	});

	describe("edit", () => {
		it("applies disjoint edits and returns both diff formats", async () => {
			const context = createContext();
			const original = "alpha\nbeta\ngamma\ndelta\n";
			getOrThrow(await context.env.writeFile("edit.txt", original));

			const result = await createEditTool().execute(
				"edit-1",
				{
					path: "edit.txt",
					edits: [
						{ oldText: "alpha\n", newText: "ALPHA\n" },
						{ oldText: "gamma\n", newText: "GAMMA\n" },
					],
				},
				undefined,
				undefined,
				context,
			);

			expect(textOutput(result)).toBe("Successfully replaced 2 block(s) in edit.txt.");
			expect(result.details?.diff).toContain("ALPHA");
			expect(result.details?.diff).toContain("GAMMA");
			expect(applyPatch(original, result.details?.patch ?? "")).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
			expect(getOrThrow(await context.env.readTextFile("edit.txt"))).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
		});

		it("matches all edits against the original and rejects overlaps", async () => {
			const context = createContext();
			getOrThrow(await context.env.writeFile("edit.txt", "one\ntwo\nthree\n"));

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
					undefined,
					undefined,
					context,
				),
			).rejects.toThrow(/overlap/);
			expect(getOrThrow(await context.env.readTextFile("edit.txt"))).toBe("one\ntwo\nthree\n");
		});

		it("rejects missing and duplicate target text", async () => {
			const context = createContext();
			getOrThrow(await context.env.writeFile("edit.txt", "foo foo foo"));
			const tool = createEditTool();

			await expect(
				tool.execute(
					"edit-3",
					{ path: "edit.txt", edits: [{ oldText: "bar", newText: "baz" }] },
					undefined,
					undefined,
					context,
				),
			).rejects.toThrow(/Could not find the exact text/);
			await expect(
				tool.execute(
					"edit-4",
					{ path: "edit.txt", edits: [{ oldText: "foo", newText: "bar" }] },
					undefined,
					undefined,
					context,
				),
			).rejects.toThrow(/Found 3 occurrences/);
		});

		it("keeps the mutation queue locked until an aborted edit write settles", async () => {
			const env = new BlockingEditExecutionEnv({ cwd: createTempDir() });
			getOrThrow(await env.writeFile("file.txt", "alpha\nbeta\n"));
			const tool = createEditTool();
			const controller = new AbortController();
			const firstEdit = tool.execute(
				"edit-first",
				{ path: "file.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
				controller.signal,
				undefined,
				{ env },
			);
			await env.firstEditWriteStarted.promise;
			controller.abort();
			const secondEdit = tool.execute(
				"edit-second",
				{ path: "file.txt", edits: [{ oldText: "beta", newText: "BETA" }] },
				undefined,
				undefined,
				{ env },
			);

			await delay(20);
			expect(env.secondEditWriteStarted).toBe(false);
			env.finishFirstEditWrite.resolve();
			await expect(firstEdit).rejects.toThrow("Operation aborted");
			await secondEdit;
			expect(env.firstEditWriteSettled).toBe(true);
			expect(getOrThrow(await env.readTextFile("file.txt"))).toBe("ALPHA\nBETA\n");
		});

		it("serializes concurrent edits through canonical and symlink paths", async () => {
			const env = new SlowReadExecutionEnv({ cwd: createTempDir() });
			getOrThrow(await env.writeFile("target.txt", "alpha\nbeta\ngamma\n"));
			await symlink("target.txt", `${env.cwd}/link.txt`);
			const tool = createEditTool();

			await Promise.all([
				tool.execute(
					"edit-target",
					{ path: "target.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
					undefined,
					undefined,
					{ env },
				),
				tool.execute(
					"edit-link",
					{ path: "link.txt", edits: [{ oldText: "beta", newText: "BETA" }] },
					undefined,
					undefined,
					{ env },
				),
			]);

			expect(getOrThrow(await env.readTextFile("target.txt"))).toBe("ALPHA\nBETA\ngamma\n");
		});

		it("edits regular files through symlinks", async () => {
			const context = createContext();
			getOrThrow(await context.env.writeFile("target.txt", "before\n"));
			await symlink("target.txt", `${context.env.cwd}/link.txt`);

			await createEditTool().execute(
				"edit-symlink",
				{ path: "link.txt", edits: [{ oldText: "before", newText: "after" }] },
				undefined,
				undefined,
				context,
			);

			expect(getOrThrow(await context.env.readTextFile("target.txt"))).toBe("after\n");
		});

		it("preserves BOM and CRLF line endings", async () => {
			const context = createContext();
			getOrThrow(await context.env.writeFile("edit.txt", "\uFEFFone\r\ntwo\r\n"));

			await createEditTool().execute(
				"edit-5",
				{ path: "edit.txt", edits: [{ oldText: "two", newText: "TWO" }] },
				undefined,
				undefined,
				context,
			);

			expect(getOrThrow(await context.env.readTextFile("edit.txt"))).toBe("\uFEFFone\r\nTWO\r\n");
		});
	});

	describe("bash", () => {
		it("executes commands and combines stdout and stderr", async () => {
			const context = createContext();
			const result = await createBashTool().execute(
				"bash-1",
				{ command: "printf out; printf err >&2" },
				undefined,
				undefined,
				context,
			);

			expect(textOutput(result)).toContain("out");
			expect(textOutput(result)).toContain("err");
		});

		it("reports nonzero exits and timeouts", async () => {
			const context = createContext();
			const tool = createBashTool();

			await expect(
				tool.execute("bash-2", { command: "printf failed; exit 7" }, undefined, undefined, context),
			).rejects.toThrow(/failed[\s\S]*Command exited with code 7/);
			await expect(
				tool.execute("bash-3", { command: "sleep 2", timeout: 0.01 }, undefined, undefined, context),
			).rejects.toThrow(/Command timed out after 0.01 seconds/);
		});

		it("preserves truncated output when a command times out", async () => {
			const context = createContext();
			let error: unknown;
			try {
				await createBashTool().execute(
					"bash-timeout-output",
					{
						command: "i=1; while [ $i -le 3000 ]; do echo line-$i; i=$((i + 1)); done; sleep 2",
						timeout: 0.05,
					},
					undefined,
					undefined,
					context,
				);
			} catch (cause) {
				error = cause;
			}

			expect(error).toBeInstanceOf(Error);
			const message = (error as Error).message;
			expect(message).toContain("Command timed out after 0.05 seconds");
			const fullOutputPath = message.match(/Full output: ([^\]\n]+)/)?.[1];
			expect(fullOutputPath).toBeDefined();
			const fullOutput = getOrThrow(await context.env.readTextFile(fullOutputPath!));
			expect(fullOutput).toContain("line-1\nline-2");
			expect(fullOutput).toContain("line-2999\nline-3000");
		});

		it("ignores output callbacks after execution settles", async () => {
			const env = new LateOutputExecutionEnv({ cwd: createTempDir() });
			const updates: string[] = [];
			const result = await createBashTool().execute(
				"bash-late",
				{ command: "late" },
				undefined,
				(update) => updates.push(textOutput(update)),
				{ env },
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
				undefined,
				undefined,
				context,
			);

			expect(textOutput(result)).toMatch(/Showing last 50\.0KB of line 1 \(line is 58\.6KB\)\. Full output:/);
		});

		it("prepares command, cwd, and an explicit environment with the turn context", async () => {
			const env = new NodeExecutionEnv({
				cwd: createTempDir(),
				shellEnv: { PI_BASH_PREPARE_INHERITED: "inherited" },
			});
			getOrThrow(await env.createDir("workspace"));
			const context = { env, workspace: `${env.cwd}/workspace` };
			const controller = new AbortController();
			let receivedContext: typeof context | undefined;
			let receivedSignal: AbortSignal | undefined;
			const tool = createBashTool<typeof context>({
				commandPrefix: "prefix=ready",
				prepare: async (execution, turnContext, signal) => {
					receivedContext = turnContext;
					receivedSignal = signal;
					execution.cwd = turnContext.workspace;
					execution.env = { PI_BASH_PREPARE_EXPLICIT: "explicit" };
					execution.inheritEnv = false;
					execution.command += `\nprintf '%s:%s:%s:%s' "$prefix" "\${PI_BASH_PREPARE_INHERITED-}" "$PI_BASH_PREPARE_EXPLICIT" "$PWD"`;
				},
			});

			const result = await tool.execute("bash-prepare", { command: ":" }, controller.signal, undefined, context);

			expect(receivedContext).toBe(context);
			expect(receivedSignal).toBe(controller.signal);
			expect(textOutput(result)).toBe(`ready::explicit:${getOrThrow(await env.canonicalPath(context.workspace))}`);
		});

		it("supports command prefixes", async () => {
			const context = createContext();
			const result = await createBashTool({ commandPrefix: "value=hello" }).execute(
				"bash-4",
				{ command: "printf $value" },
				undefined,
				undefined,
				context,
			);

			expect(textOutput(result)).toBe("hello");
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
				undefined,
				(update) => updates.push(update),
				context,
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
			const fullOutput = getOrThrow(await context.env.readTextFile(result.details!.fullOutputPath!));
			expect(fullOutput).toContain("line-1\nline-2");
			expect(fullOutput).toContain("line-2999\nline-3000");
		});
	});
});
