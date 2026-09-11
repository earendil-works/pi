import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access, chmod, realpath, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { FileError, getOrThrow, type ShellExecOptions, type ShellOutputView } from "../../src/harness/types.ts";
import { applyShellOutputUpdate } from "../../src/harness/utils/output-capture.ts";
import { executeShellWithCapture } from "../../src/harness/utils/shell-output.ts";
import { createTempDir } from "./session-test-utils.ts";

const chmodRestorePaths: string[] = [];

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			onTimeout?.();
			reject(new Error(`Timed out after ${ms}ms`));
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timeoutId);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeoutId);
				reject(error);
			},
		);
	});
}

async function collectShellOutput(
	env: NodeExecutionEnv,
	command: string,
	options: ShellExecOptions | undefined,
	context: Parameters<NodeExecutionEnv["exec"]>[2],
): Promise<{ result: Awaited<ReturnType<NodeExecutionEnv["exec"]>>; output: ShellOutputView | undefined }> {
	let output: ShellOutputView | undefined;
	const result = await env.exec(
		command,
		{
			...options,
			onUpdate: (update) => {
				output = applyShellOutputUpdate(output, update);
			},
		},
		context,
	);
	return { result, output };
}

function toBashSingleQuotedArg(value: string): string {
	return `'${value.replace(/\\/g, "/").replace(/'/g, `'"'"'`)}'`;
}

function createInheritedStdioCommand(pidFile: string): string {
	return (
		'node -e "' +
		"const fs=require('fs');" +
		"const {spawn}=require('child_process');" +
		"const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit',detached:true});" +
		"fs.writeFileSync(process.argv[1], String(child.pid));" +
		"child.unref();" +
		"console.log('child-exiting');" +
		'" ' +
		toBashSingleQuotedArg(pidFile)
	);
}

function cleanupDetachedChild(pidFile: string): void {
	if (!existsSync(pidFile)) return;
	const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
	if (!Number.isFinite(pid) || pid <= 0) return;
	try {
		execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
	} catch {}
}

class FailingSpillExecutionEnv extends NodeExecutionEnv {
	override async createTempFile(
		options: Parameters<NodeExecutionEnv["createTempFile"]>[0],
		context: Parameters<NodeExecutionEnv["createTempFile"]>[1],
	) {
		if (options?.prefix === "pi-output-") {
			return { ok: true as const, value: join(this.cwd, "missing", "spill.log") };
		}
		return super.createTempFile(options, context);
	}
}

afterEach(async () => {
	for (const path of chmodRestorePaths.splice(0)) {
		try {
			await access(path);
			await chmod(path, 0o700);
		} catch {}
	}
});

describe("NodeExecutionEnv", () => {
	it("reads, writes, lists, and removes files and directories", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		expect(getOrThrow(await env.absolutePath("nested/child", BACKGROUND_CONTEXT))).toBe(join(root, "nested/child"));
		expect(getOrThrow(await env.joinPath([root, "nested", "child"], BACKGROUND_CONTEXT))).toBe(
			join(root, "nested", "child"),
		);
		getOrThrow(await env.createDir("nested/child", undefined, BACKGROUND_CONTEXT));
		getOrThrow(await env.writeFile("nested/child/file.txt", "hel", BACKGROUND_CONTEXT));
		getOrThrow(await env.appendFile("nested/child/file.txt", "lo", BACKGROUND_CONTEXT));
		expect(getOrThrow(await env.readTextFile("nested/child/file.txt", BACKGROUND_CONTEXT))).toBe("hello");
		expect(getOrThrow(await env.readTextLines("nested/child/file.txt", { maxLines: 1 }, BACKGROUND_CONTEXT))).toEqual(
			["hello"],
		);
		expect(
			Buffer.from(getOrThrow(await env.readBinaryFile("nested/child/file.txt", BACKGROUND_CONTEXT))).toString(
				"utf8",
			),
		).toBe("hello");

		const entries = getOrThrow(await env.listDir("nested/child", BACKGROUND_CONTEXT));
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			name: "file.txt",
			path: join(root, "nested/child/file.txt"),
			kind: "file",
			size: 5,
		});
		expect(typeof entries[0]!.mtimeMs).toBe("number");

		expect(getOrThrow(await env.exists("nested/child/file.txt", BACKGROUND_CONTEXT))).toBe(true);
		getOrThrow(await env.remove("nested/child/file.txt", undefined, BACKGROUND_CONTEXT));
		expect(getOrThrow(await env.exists("nested/child/file.txt", BACKGROUND_CONTEXT))).toBe(false);
	});

	it("expands home-relative paths and file URLs", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		expect(getOrThrow(await env.absolutePath("~/pi-node-env-test", BACKGROUND_CONTEXT))).toBe(
			join(homedir(), "pi-node-env-test"),
		);
		const filePath = join(root, "file with spaces.txt");
		expect(getOrThrow(await env.absolutePath(pathToFileURL(filePath).href, BACKGROUND_CONTEXT))).toBe(filePath);
	});

	it("returns fileInfo for files, directories, and symlinks without following symlinks", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(await env.createDir("dir", { recursive: true }, BACKGROUND_CONTEXT));
		getOrThrow(await env.writeFile("dir/file.txt", "hello", BACKGROUND_CONTEXT));
		await symlink(join(root, "dir/file.txt"), join(root, "file-link"));
		await symlink(join(root, "dir"), join(root, "dir-link"));

		expect(getOrThrow(await env.fileInfo("dir", BACKGROUND_CONTEXT))).toMatchObject({
			name: "dir",
			path: join(root, "dir"),
			kind: "directory",
		});
		expect(getOrThrow(await env.fileInfo("dir/file.txt", BACKGROUND_CONTEXT))).toMatchObject({
			name: "file.txt",
			path: join(root, "dir/file.txt"),
			kind: "file",
			size: 5,
		});
		expect(getOrThrow(await env.fileInfo("file-link", BACKGROUND_CONTEXT))).toMatchObject({
			name: "file-link",
			path: join(root, "file-link"),
			kind: "symlink",
		});
		expect(getOrThrow(await env.fileInfo("dir-link", BACKGROUND_CONTEXT))).toMatchObject({
			name: "dir-link",
			path: join(root, "dir-link"),
			kind: "symlink",
		});
		expect(getOrThrow(await env.canonicalPath("file-link", BACKGROUND_CONTEXT))).toBe(
			await realpath(join(root, "dir/file.txt")),
		);
	});

	it("lists symlinks as symlinks", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(await env.writeFile("target.txt", "hello", BACKGROUND_CONTEXT));
		await symlink(join(root, "target.txt"), join(root, "link.txt"));

		const entries = getOrThrow(await env.listDir(".", BACKGROUND_CONTEXT));
		expect(
			entries.map((entry) => ({ name: entry.name, kind: entry.kind })).sort((a, b) => a.name.localeCompare(b.name)),
		).toEqual([
			{ name: "link.txt", kind: "symlink" },
			{ name: "target.txt", kind: "file" },
		]);
	});

	it("stops reading text lines at the requested limit", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(await env.writeFile("file.txt", "one\ntwo\nthree", BACKGROUND_CONTEXT));
		expect(getOrThrow(await env.readTextLines("file.txt", { maxLines: 1 }, BACKGROUND_CONTEXT))).toEqual(["one"]);
	});

	it("returns FileError for missing paths and keeps exists false for missing paths", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const info = await env.fileInfo("missing.txt", BACKGROUND_CONTEXT);
		expect(info.ok).toBe(false);
		if (!info.ok) {
			expect(info.error).toBeInstanceOf(FileError);
			expect(info.error).toMatchObject({
				name: "FileError",
				code: "not_found",
				path: join(root, "missing.txt"),
			});
		}
		expect(getOrThrow(await env.exists("missing.txt", BACKGROUND_CONTEXT))).toBe(false);
	});

	it("returns FileError for listing non-directories", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(await env.writeFile("file.txt", "hello", BACKGROUND_CONTEXT));
		const result = await env.listDir("file.txt", BACKGROUND_CONTEXT);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBeInstanceOf(FileError);
			expect(result.error).toMatchObject({ code: "not_directory" });
		}
	});

	it("appends to new files and creates parent directories", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(await env.appendFile("new/nested/file.txt", "a", BACKGROUND_CONTEXT));
		getOrThrow(await env.appendFile("new/nested/file.txt", "b", BACKGROUND_CONTEXT));
		expect(getOrThrow(await env.readTextFile("new/nested/file.txt", BACKGROUND_CONTEXT))).toBe("ab");
	});

	it("atomically renames a file and replaces the destination", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(await env.writeFile("source.txt", "new", BACKGROUND_CONTEXT));
		getOrThrow(await env.writeFile("destination.txt", "old", BACKGROUND_CONTEXT));

		getOrThrow(await env.renameFile("source.txt", "destination.txt", BACKGROUND_CONTEXT));

		expect(getOrThrow(await env.exists("source.txt", BACKGROUND_CONTEXT))).toBe(false);
		expect(getOrThrow(await env.readTextFile("destination.txt", BACKGROUND_CONTEXT))).toBe("new");
	});

	it("reports the source path when rename fails because the source is missing", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(await env.writeFile("destination.txt", "unchanged", BACKGROUND_CONTEXT));

		const result = await env.renameFile("missing-source.txt", "destination.txt", BACKGROUND_CONTEXT);

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: "not_found",
				path: join(root, "missing-source.txt"),
			},
		});
		expect(getOrThrow(await env.readTextFile("destination.txt", BACKGROUND_CONTEXT))).toBe("unchanged");
	});

	it("creates temporary directories and files", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const tempDir = getOrThrow(await env.createTempDir("node-env-test-", BACKGROUND_CONTEXT));
		await expect(access(tempDir)).resolves.toBeUndefined();
		const tempFile = getOrThrow(await env.createTempFile({ prefix: "prefix-", suffix: ".txt" }, BACKGROUND_CONTEXT));
		await expect(access(tempFile)).resolves.toBeUndefined();
		expect(tempFile.endsWith(".txt")).toBe(true);
	});

	it("honors createDir recursive false and remove recursive/force options", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const createResult = await env.createDir("missing/child", { recursive: false }, BACKGROUND_CONTEXT);
		expect(createResult.ok).toBe(false);
		if (!createResult.ok) expect(createResult.error).toMatchObject({ code: "not_found" });

		getOrThrow(await env.writeFile("dir/child/file.txt", "hello", BACKGROUND_CONTEXT));
		const removeDirectory = await env.remove("dir", { recursive: false }, BACKGROUND_CONTEXT);
		expect(removeDirectory.ok).toBe(false);
		getOrThrow(await env.remove("dir", { recursive: true }, BACKGROUND_CONTEXT));
		expect(getOrThrow(await env.exists("dir", BACKGROUND_CONTEXT))).toBe(false);

		const removeMissing = await env.remove("missing", { force: false }, BACKGROUND_CONTEXT);
		expect(removeMissing.ok).toBe(false);
		getOrThrow(await env.remove("missing", { force: true }, BACKGROUND_CONTEXT));
	});

	it("returns aborted results for pre-aborted cancellable file operations", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(await env.writeFile("file.txt", "hello", BACKGROUND_CONTEXT));
		const controller = new AbortController();
		controller.abort();
		const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);

		const results = await Promise.all([
			env.readTextFile("file.txt", context),
			env.readTextLines("file.txt", undefined, context),
			env.readBinaryFile("file.txt", context),
			env.writeFile("other.txt", "hello", context),
			env.renameFile("file.txt", "renamed.txt", context),
			env.listDir(".", context),
		]);
		for (const result of results) {
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toMatchObject({ code: "aborted" });
		}
	});

	it("cleanup is best-effort", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await expect(env.cleanup(BACKGROUND_CONTEXT)).resolves.toBeUndefined();
	});

	it("executes commands in cwd with env overrides", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const collected = await collectShellOutput(
			env,
			'printf \'%s:%s\' "$PWD" "$NODE_ENV_TEST"',
			{ env: { NODE_ENV_TEST: "ok" } },
			BACKGROUND_CONTEXT,
		);
		const result = getOrThrow(collected.result);
		expect(collected.output?.text).toBe(`${await realpath(root)}:ok`);
		expect(result.exitCode).toBe(0);
	});

	it.each([
		["a missing override preserves the base value", undefined, "x:/stale/parent.jsonl"],
		["an empty override shadows the base value", { PI_SESSION_FILE: "" }, "x:"],
		[
			"a string override replaces the base value",
			{ PI_SESSION_FILE: "/sessions/current.jsonl" },
			"x:/sessions/current.jsonl",
		],
	] as const)(
		"applies string shell environment overrides when %s",
		async (_description, overrides, expectedSessionFile) => {
			const root = createTempDir();
			const env = new NodeExecutionEnv({
				cwd: root,
				shellEnv: {
					PI_SESSION_FILE: "/stale/parent.jsonl",
					PI_CODING_AGENT: "true",
					PI_NODE_ENV_PRESERVED_TEST: "preserved",
				},
			});
			const collected = await collectShellOutput(
				env,
				`printf '%s:%s|%s|%s' "\${PI_SESSION_FILE+x}" "\${PI_SESSION_FILE-}" "$PI_CODING_AGENT" "$PI_NODE_ENV_PRESERVED_TEST"`,
				{ env: overrides },
				BACKGROUND_CONTEXT,
			);
			getOrThrow(collected.result);
			expect(collected.output?.text).toBe(`${expectedSessionFile}|true|preserved`);
		},
	);

	it("can replace rather than inherit the default shell environment", async () => {
		const root = createTempDir();
		const inheritedKey = "PI_NODE_ENV_INHERITED_TEST";
		const configuredKey = "PI_NODE_ENV_CONFIGURED_TEST";
		const explicitKey = "PI_NODE_ENV_EXPLICIT_TEST";
		const previousInherited = process.env[inheritedKey];
		process.env[inheritedKey] = "host";
		try {
			const env = new NodeExecutionEnv({ cwd: root, shellEnv: { [configuredKey]: "configured" } });
			const collected = await collectShellOutput(
				env,
				`printf '%s:%s:%s' "\${${inheritedKey}-}" "\${${configuredKey}-}" "\${${explicitKey}-}"`,
				{ inheritEnv: false, env: { [explicitKey]: "explicit" } },
				BACKGROUND_CONTEXT,
			);
			getOrThrow(collected.result);
			expect(collected.output?.text).toBe("::explicit");
		} finally {
			if (previousInherited === undefined) delete process.env[inheritedKey];
			else process.env[inheritedKey] = previousInherited;
		}
	});

	it("uses stdin command transport for legacy WSL bash paths", async () => {
		if (process.platform === "win32") return;
		const root = createTempDir();
		const shellPath = "C:\\Windows\\System32\\bash.exe";
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(
			await env.writeFile(
				shellPath,
				'#!/bin/sh\nprintf \'args:%s\\n\' "$*" >&2\nexec /bin/bash "$@"\n',
				BACKGROUND_CONTEXT,
			),
		);
		await chmod(join(root, shellPath), 0o755);

		const originalCwd = process.cwd();
		const originalPath = process.env.PATH;
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		try {
			process.chdir(root);
			process.env.PATH = `${root}${delimiter}${originalPath ?? ""}`;
			Object.defineProperty(process, "platform", {
				configurable: true,
				value: "win32",
			});

			const wslEnv = new NodeExecutionEnv({ cwd: root, shellPath });
			const nameExpansion = "$" + "{name}";
			const collected = await collectShellOutput(
				wslEnv,
				`name='World'; echo "Hello, ${nameExpansion}!"`,
				undefined,
				BACKGROUND_CONTEXT,
			);
			const result = getOrThrow(collected.result);
			expect(collected.output?.text).toContain("Hello, World!");
			expect(collected.output?.text).toContain("args:-s");
			expect(result.exitCode).toBe(0);
		} finally {
			process.chdir(originalCwd);
			process.env.PATH = originalPath;
			if (platformDescriptor) {
				Object.defineProperty(process, "platform", platformDescriptor);
			}
		}
	});

	it.skipIf(process.platform !== "win32")(
		"settles after the shell exits when a detached descendant retains inherited stdio",
		async () => {
			const root = createTempDir();
			const pidFile = join(root, "grandchild.pid");
			const env = new NodeExecutionEnv({ cwd: root });
			const controller = new AbortController();
			try {
				const collected = await withTimeout(
					collectShellOutput(
						env,
						createInheritedStdioCommand(pidFile),
						undefined,
						withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
					),
					3000,
					() => controller.abort(),
				);
				getOrThrow(collected.result);
				expect(collected.output?.text).toContain("child-exiting");
			} finally {
				controller.abort();
				cleanupDetachedChild(pidFile);
			}
		},
	);

	it("cleanup terminates active shell processes", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const execution = env.exec("touch started; sleep 60", undefined, BACKGROUND_CONTEXT);
		for (let attempt = 0; attempt < 100 && !getOrThrow(await env.exists("started", BACKGROUND_CONTEXT)); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(getOrThrow(await env.exists("started", BACKGROUND_CONTEXT))).toBe(true);
		await env.cleanup(BACKGROUND_CONTEXT);
		await expect(withTimeout(execution, 3000)).resolves.toMatchObject({ ok: true });
	});

	it("combines stdout and stderr into one bounded view", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const updates: string[] = [];
		let output: ShellOutputView | undefined;
		const result = getOrThrow(
			await env.exec(
				"printf out; printf err >&2",
				{
					onUpdate: (update) => {
						updates.push(update.kind);
						output = applyShellOutputUpdate(output, update);
					},
				},
				BACKGROUND_CONTEXT,
			),
		);
		expect(result.exitCode).toBe(0);
		expect(output?.text).toContain("out");
		expect(output?.text).toContain("err");
		expect(updates[0]).toBe("replace");
	});

	it("reports a missing working directory before spawning", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: join(root, "missing") });
		const result = await env.exec("printf ok", undefined, BACKGROUND_CONTEXT);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "spawn_error", message: expect.stringContaining("Working directory does not exist") },
		});
	});

	it("returns non-zero command exit codes as successful execution results", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = getOrThrow(await env.exec("exit 7", undefined, BACKGROUND_CONTEXT));
		expect(result.exitCode).toBe(7);
		expect(result.truncation.totalBytes).toBe(0);
	});

	// Regression test for https://github.com/earendil-works/pi/issues/8992
	it.skipIf(process.platform === "win32")("maps signal-killed processes to a non-zero exit code", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = getOrThrow(await env.exec("kill -9 $$", undefined, BACKGROUND_CONTEXT));
		expect(result.exitCode).toBe(128 + 9);
	});

	it("returns timeout errors for commands exceeding the timeout", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = await env.exec("sleep 5", { timeout: 0.01 }, BACKGROUND_CONTEXT);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatchObject({ code: "timeout" });
	});

	it("returns callback errors from exec stream handlers", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = await env.exec(
			"printf out",
			{
				onUpdate: () => {
					throw new Error("callback failed");
				},
			},
			BACKGROUND_CONTEXT,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatchObject({ code: "callback_error", message: "callback failed" });
	});

	it("returns shell unavailable and spawn errors", async () => {
		const root = createTempDir();
		const missingShellEnv = new NodeExecutionEnv({ cwd: root, shellPath: join(root, "missing-shell") });
		const missingShell = await missingShellEnv.exec("printf ok", undefined, BACKGROUND_CONTEXT);
		expect(missingShell.ok).toBe(false);
		if (!missingShell.ok) expect(missingShell.error).toMatchObject({ code: "shell_unavailable" });

		const shellPath = join(root, "not-executable-shell");
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(await env.writeFile(shellPath, "not executable", BACKGROUND_CONTEXT));
		const spawnErrorEnv = new NodeExecutionEnv({ cwd: root, shellPath });
		const spawnError = await spawnErrorEnv.exec("printf ok", undefined, BACKGROUND_CONTEXT);
		expect(spawnError.ok).toBe(false);
		if (!spawnError.ok) expect(spawnError.error).toMatchObject({ code: "spawn_error" });
	});

	it("returns an aborted result for aborted commands", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const controller = new AbortController();
		const promise = env.exec("sleep 5", undefined, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
		controller.abort();
		const result = await promise;
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatchObject({ code: "aborted" });
	});

	it.skipIf(process.platform === "win32")("ignores asynchronous taskkill spawn errors during abort", async () => {
		const root = createTempDir();
		const pidFile = join(root, "shell.pid");
		const controller = new AbortController();
		const env = new NodeExecutionEnv({ cwd: root, shellPath: "/bin/bash" });
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		const previousSystemRoot = process.env.SystemRoot;
		process.env.SystemRoot = "/definitely/missing/windows";
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });

		let pid: number | undefined;
		try {
			const execution = env.exec(
				`echo $$ > ${toBashSingleQuotedArg(pidFile)}; exec sleep 60`,
				undefined,
				withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
			);
			for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(existsSync(pidFile)).toBe(true);

			controller.abort();
			await new Promise((resolve) => setTimeout(resolve, 0));
			pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
			process.kill(pid, "SIGKILL");

			const result = await execution;
			expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
		} finally {
			if (pid === undefined && existsSync(pidFile)) {
				pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
			}
			if (pid !== undefined && Number.isFinite(pid)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
			if (previousSystemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = previousSystemRoot;
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		}
	});

	it("does not create a spill before bounded output crosses its limits", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = getOrThrow(
			await env.exec(
				"printf short",
				{
					capture: { limits: { maxBytes: 100, maxLines: 10, retain: "tail" }, spill: true },
					onUpdate: () => {},
				},
				BACKGROUND_CONTEXT,
			),
		);
		expect(result.spillPath).toBeUndefined();
	});

	it("preserves exact raw bytes in the spill while decoding a bounded text view", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const expected = [0x66, 0x80, 0x00, 0x6f];
		const result = getOrThrow(
			await env.exec(
				`${JSON.stringify(process.execPath)} -e "process.stdout.write(Buffer.from([${expected.join(",")}]))"`,
				{
					capture: { limits: { maxBytes: 1, maxLines: 10, retain: "tail" }, spill: true },
					onUpdate: () => {},
				},
				BACKGROUND_CONTEXT,
			),
		);
		expect(result.spillPath).toBeDefined();
		expect([...getOrThrow(await env.readBinaryFile(result.spillPath!, BACKGROUND_CONTEXT))]).toEqual(expected);
	});

	it("fails rather than silently losing a requested spill", async () => {
		const root = createTempDir();
		const env = new FailingSpillExecutionEnv({ cwd: root });
		const result = await env.exec(
			"printf 12345678901234567890",
			{
				capture: { limits: { maxBytes: 10, maxLines: 10, retain: "tail" }, spill: true },
				onUpdate: () => {},
			},
			BACKGROUND_CONTEXT,
		);
		expect(result).toMatchObject({
			ok: false,
			error: { code: "unknown", message: expect.stringContaining("Failed to preserve complete shell output") },
		});
	});

	it("preserves complete output when spill-stream backpressure pauses a process that exits quickly", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const size = 500_000;
		const result = getOrThrow(
			await env.exec(
				`${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(${size}))"`,
				{
					capture: { limits: { maxBytes: 10, maxLines: 10, retain: "tail" }, spill: true },
					onUpdate: () => {},
				},
				BACKGROUND_CONTEXT,
			),
		);
		expect(result.spillPath).toBeDefined();
		expect(getOrThrow(await env.readTextFile(result.spillPath!, BACKGROUND_CONTEXT))).toHaveLength(size);
	});

	it("captures large shell output to a full output file through the execution env", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = getOrThrow(
			await executeShellWithCapture(env, "yes line | head -n 15000", undefined, BACKGROUND_CONTEXT),
		);
		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeDefined();
		const fullOutput = getOrThrow(await env.readTextFile(result.fullOutputPath!, BACKGROUND_CONTEXT));
		expect(fullOutput.split("\n").length).toBeGreaterThan(10000);
		expect(result.output.length).toBeLessThan(fullOutput.length);
	});
});
