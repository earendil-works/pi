import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const native = fileURLToPath(new URL("../native/linux/", import.meta.url));
const supported = process.platform === "linux" && ["arm64", "x64"].includes(process.arch);
const dependenciesAvailable =
	supported &&
	spawnSync("sh", ["-c", "command -v cc && command -v Xvfb && command -v xclip && pkg-config --exists xcb"], {
		stdio: "ignore",
	}).status === 0;

interface ReaderResult {
	ok: boolean;
	value?: string | null;
	unavailable?: boolean;
	length?: number;
	hash?: string;
	error?: string;
}

async function startServer(
	t: TestContext,
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<{ child: ChildProcessWithoutNullStreams; ready: string }> {
	const child = spawn(command, args, { env, stdio: "pipe" });
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
	});
	let stderr = "";
	child.stderr.on("data", (data: Buffer) => {
		stderr += data.toString();
	});
	const ready = await new Promise<string>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`${command} exited with ${code}: ${stderr}`)));
		child.stdout.once("data", (data: Buffer) => resolve(data.toString().trim()));
	});
	return { child, ready };
}

async function readClipboard(method: string, env: NodeJS.ProcessEnv): Promise<ReaderResult> {
	const { stdout } = await exec(
		process.execPath,
		[
			join(fixtures, "clipboard-reader.cjs"),
			join(native, "prebuilds", `linux-${process.arch}`, "linux-platform-x11.node"),
			method,
		],
		{ env, timeout: 6000 },
	);
	return JSON.parse(stdout) as ReaderResult;
}

describe("native Linux clipboard", { skip: !dependenciesAvailable, timeout: 60000 }, () => {
	let directory: string;

	async function startX11(t: TestContext) {
		const { child, ready } = await startServer(
			t,
			"Xvfb",
			["-displayfd", "1", "-screen", "0", "640x480x24", "-nolisten", "tcp"],
			process.env,
		);
		return { child, env: { ...process.env, DISPLAY: `:${ready}` } };
	}

	before(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-clipboard-test-"));
		const flags = ["-std=c11", "-D_POSIX_C_SOURCE=200809L", "-Wall", "-Wextra", "-Werror", "-pthread"];
		execFileSync("cc", [
			...flags,
			join(fixtures, "clipboard-x11-test.c"),
			"-lxcb",
			"-ldl",
			"-o",
			join(directory, "x11-test"),
		]);
		execFileSync("cc", [
			...flags,
			"-shared",
			"-fPIC",
			"-nostdlib", // Match the prebuild's unversioned system-library imports.
			...(process.arch === "arm64" ? ["-mno-outline-atomics"] : []), // Inline the fixture's allocation counters.
			"-Wl,-z,nodelete",
			join(fixtures, "clipboard-worker-test.c"),
			"-ldl",
			"-o",
			join(directory, "worker-test.node"),
		]);
	});

	after(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
	});

	it("validates X11 incremental property metadata before accumulating bytes", () => {
		assert.equal(execFileSync(join(directory, "x11-test"), ["metadata"], { encoding: "utf8" }).trim(), "validated");
	});

	for (const mode of ["concurrent", "process-exit", "worker-exit"]) {
		it(`bounds private clipboard work and preserves cleanup: ${mode}`, async () => {
			const { stdout } = await exec(
				process.execPath,
				[join(fixtures, "clipboard-worker-test.cjs"), join(directory, "worker-test.node"), mode],
				{ env: { ...process.env, UV_THREADPOOL_SIZE: "2" }, timeout: 10000 },
			);
			assert.equal(stdout.trim(), "passed");
		});
	}

	for (const method of ["getText", "getImage"]) {
		it(`keeps JS responsive during stalled X11 connection setup: ${method}`, async (t) => {
			const sockets = new Set<Socket>();
			let connections = 0;
			const server = createServer((socket) => {
				connections++;
				sockets.add(socket);
				socket.on("data", () => {}); // Accept setup bytes without replying.
				// libxcb owns setup blocking; release it after checking the JS timer.
				const timer = setTimeout(() => socket.destroy(), 300);
				t.after(() => clearTimeout(timer));
				socket.on("close", () => sockets.delete(socket));
			});
			t.after(async () => {
				for (const socket of sockets) socket.destroy();
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			});
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const address = server.address();
			assert.ok(address && typeof address !== "string" && address.port > 6000);
			const env = { ...process.env, DISPLAY: `127.0.0.1:${address.port - 6000}` };
			const started = performance.now();
			const result = await readClipboard(method, env);
			assert.ok(performance.now() - started < 3500, "The worker must return after the connection closes");
			assert.deepEqual(result, { ok: true, unavailable: true });
			assert.ok(connections > 0, "The helper must reach the stalled X11 server");
			assert.equal(sockets.size, 0, "The failed connection must be closed");
		});
	}

	it("decodes X11 STRING as Latin-1", async (t) => {
		const { env } = await startX11(t);
		execFileSync("xclip", ["-selection", "clipboard", "-in", "-t", "STRING"], {
			env,
			input: Buffer.from("café £ÿ", "latin1"),
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 5000,
		});
		const result = await readClipboard("getText", env);
		assert.equal(result.ok, true, result.error);
		assert.equal(result.value, "café £ÿ");
	});

	it("reads UTF8_STRING when X11 TARGETS is refused", async (t) => {
		const { env } = await startX11(t);
		await startServer(t, join(directory, "x11-test"), ["direct-text"], env);
		const result = await readClipboard("getText", env);
		assert.equal(result.ok, true, result.error);
		assert.equal(result.value, "café 日本語");
	});

	it("returns null for empty X11 clipboards and text-only selections", async (t) => {
		const { env } = await startX11(t);
		assert.deepEqual(await readClipboard("getText", env), { ok: true, value: null });
		assert.deepEqual(await readClipboard("getImage", env), { ok: true, value: null });
		execFileSync("xclip", ["-selection", "clipboard", "-in", "-t", "UTF8_STRING"], {
			env,
			input: "text only",
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 5000,
		});
		assert.deepEqual(await readClipboard("getImage", env), { ok: true, value: null });
	});

	it("preserves X11 Unicode and incremental text/image transfers", async (t) => {
		const { env } = await startX11(t);
		for (const [target, method, bytes] of [
			["UTF8_STRING", "getText", Buffer.from("café 日本語")],
			["UTF8_STRING", "getText", Buffer.alloc(4 * 1024 * 1024, 120)],
			["image/png", "getImage", Buffer.alloc(4 * 1024 * 1024, 123)],
		] as const) {
			execFileSync("xclip", ["-selection", "clipboard", "-in", "-t", target], {
				env,
				input: bytes,
				stdio: ["pipe", "ignore", "ignore"],
				timeout: 5000,
			});
			const result = await readClipboard(method, env);
			assert.equal(result.ok, true, result.error);
			assert.equal(result.length, bytes.length);
			assert.equal(result.hash, createHash("sha256").update(bytes).digest("hex"));
		}
	});

	for (const mode of ["disconnect", "timeout"]) {
		it(`reports X11 transfer ${mode} as an exception, not an unavailable display`, async (t) => {
			const { child, env } = await startX11(t);
			const owner = await startServer(t, join(directory, "x11-test"), ["idle"], env);
			const requested = once(owner.child.stdout, "data");
			const started = performance.now();
			const result = readClipboard("getText", env);
			await requested;
			if (mode === "disconnect") child.kill("SIGKILL");
			const failure = await result;
			assert.equal(failure.ok, false);
			assert.match(failure.error ?? "", /X11 clipboard/);
			assert.ok(performance.now() - started < 3500, "The transfer must share the 2-second deadline");
		});
	}

	for (const content of ["text", "image"]) {
		it(`frees partially received X11 ${content} after invalid metadata`, async (t) => {
			const { env } = await startX11(t);
			await startServer(t, join(directory, "x11-test"), ["invalid"], env);
			const { stdout } = await exec(join(directory, "x11-test"), [content], { env, timeout: 6000 });
			assert.equal(stdout.trim(), "clean");
		});

		it(`times out stalled X11 ${content} after a partial transfer without blocking JS`, async (t) => {
			const { env } = await startX11(t);
			await startServer(t, join(directory, "x11-test"), ["partial"], env);
			const started = performance.now();
			const result = await readClipboard(content === "text" ? "getText" : "getImage", env);
			assert.equal(result.ok, false);
			assert.match(result.error ?? "", /X11 clipboard/);
			assert.ok(performance.now() - started < 3500);
		});
	}
});
