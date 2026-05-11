import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { assertHostAllowed, isLoopbackHost, parseWebArgs } from "../src/modes/web/args.js";
import { assertAuthorized, assertSafeOrigin, requestHasToken, tokenCookie } from "../src/modes/web/auth.js";
import { HttpError, readJsonBody, sendStaticFile } from "../src/modes/web/http.js";
import { RpcBridge } from "../src/modes/web/rpc-bridge.js";
import { deleteWebSkill, listWebSkills, resolveSkillPath, writeWebSkill } from "../src/modes/web/skills.js";
import { TerminalManager, TerminalUnavailableError } from "../src/modes/web/terminal.js";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	delete process.env[ENV_AGENT_DIR];
	for (const dir of tempDirs.splice(0)) {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

async function tempDir(): Promise<string> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-web-test-"));
	tempDirs.push(dir);
	return dir;
}

function request(body: string, headers: Record<string, string> = {}, method = "POST"): IncomingMessage {
	const readable = Readable.from([body]) as IncomingMessage;
	readable.headers = headers;
	readable.method = method;
	return readable;
}

describe("web args", () => {
	test("defaults to remote access without an auth token", () => {
		const result = parseWebArgs([]);
		expect(result).toMatchObject({
			port: 5173,
			host: "0.0.0.0",
			open: true,
			allowRemote: true,
			rpcArgs: [],
		});
		expect(result.token).toBeUndefined();
	});

	test("parses public flags and keeps remaining args for rpc", () => {
		const result = parseWebArgs([
			"--port",
			"0",
			"--host",
			"localhost",
			"--no-open",
			"--token",
			"test",
			"--model",
			"gpt",
		]);
		expect(result).toMatchObject({
			port: 0,
			host: "localhost",
			open: false,
			token: "test",
			rpcArgs: ["--model", "gpt"],
		});
	});

	test("allows remote hosts by default", () => {
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("0.0.0.0")).toBe(false);
		expect(() => assertHostAllowed({ host: "0.0.0.0", allowRemote: false })).not.toThrow();
		expect(() => assertHostAllowed({ host: "0.0.0.0", allowRemote: true })).not.toThrow();
	});
});

describe("web auth", () => {
	test("accepts bearer and cookie tokens", () => {
		expect(requestHasToken(request("", { authorization: "Bearer secret" }), "secret")).toBe(true);
		expect(requestHasToken(request("", { cookie: tokenCookie("secret") }), "secret")).toBe(true);
		expect(() => assertAuthorized(request("", { cookie: tokenCookie("wrong") }), "secret")).toThrow(HttpError);
	});

	test("rejects unsafe cross-origin mutations", () => {
		expect(() =>
			assertSafeOrigin(request("", { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" })),
		).not.toThrow();
		expect(() => assertSafeOrigin(request("", { host: "127.0.0.1:5173", origin: "http://example.test" }))).toThrow(
			HttpError,
		);
		expect(() =>
			assertSafeOrigin(request("", { host: "127.0.0.1:5173", origin: "http://example.test" }, "GET")),
		).not.toThrow();
	});
});

describe("web http", () => {
	test("rejects oversized JSON bodies", async () => {
		await expect(readJsonBody(request('{"ok":true}'), 4)).rejects.toMatchObject({ status: 413 });
	});

	test("rejects static traversal outside the web root", async () => {
		const root = await tempDir();
		const res = {
			writeHead: vi.fn(),
			end: vi.fn(),
		};
		await expect(sendStaticFile(res as never, root, "../secret.txt")).rejects.toMatchObject({ status: 404 });
	});
});

describe("web skills", () => {
	test("includes read-only built-in ask-question skill", async () => {
		const root = await tempDir();
		const builtinsRoot = await tempDir();
		const skillDir = path.join(builtinsRoot, "ask-question");
		await fsp.mkdir(skillDir, { recursive: true });
		await fsp.writeFile(
			path.join(skillDir, "SKILL.md"),
			"---\nname: ask-question\ndescription: Ask a question\n---\n# Ask Question\n",
			"utf8",
		);
		const skills = await listWebSkills(root, builtinsRoot);
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({ name: "ask-question", builtin: true });
		await expect(deleteWebSkill(skills[0].path, root)).rejects.toMatchObject({ status: 400 });
	});

	test("validates skill CRUD and safe paths", async () => {
		const agentDir = await tempDir();
		process.env[ENV_AGENT_DIR] = agentDir;
		const root = path.join(agentDir, "skills");
		const builtinsRoot = await tempDir();
		const content = "---\nname: demo\ndescription: useful\n---\n# Demo\n";
		const skill = await writeWebSkill({ name: "Demo", description: "useful", content }, "POST", root);
		expect(skill.name).toBe("demo");
		expect((await listWebSkills(root, builtinsRoot)).map((item) => item.name)).toEqual(["demo"]);
		expect(() => resolveSkillPath(path.join(agentDir, "outside", "SKILL.md"), root)).toThrow(HttpError);
		await deleteWebSkill(skill.path, root);
		expect(await listWebSkills(root, builtinsRoot)).toEqual([]);
	});

	test("rejects malformed skill writes with 400 errors", async () => {
		await expect(
			writeWebSkill({ name: "", description: "x", content: "x" }, "POST", await tempDir()),
		).rejects.toMatchObject({
			status: 400,
		});
	});
});

describe("terminal manager", () => {
	test("starts, writes, resizes, stops, and caps replay", async () => {
		const cwd = await tempDir();
		let dataHandler: ((data: string) => void) | undefined;
		let exitHandler: ((event: { exitCode: number; signal?: number }) => void) | undefined;
		let spawnedArgs: string[] = [];
		const writes: string[] = [];
		const resizes: Array<[number, number]> = [];
		const broadcasts: unknown[] = [];
		let spawnedTerm: string | undefined;
		const manager = new TerminalManager({
			broadcast: (event) => broadcasts.push(event),
			loadPty: () => ({
				spawn: (_file, args, options) => {
					spawnedArgs = args;
					spawnedTerm = options.env.TERM;
					return {
						pid: 123,
						process: "shell",
						write: (data: string) => writes.push(data),
						resize: (cols: number, rows: number) => resizes.push([cols, rows]),
						kill: () => exitHandler?.({ exitCode: 0 }),
						onData: (callback: (data: string) => void) => {
							dataHandler = callback;
							return { dispose: vi.fn() };
						},
						onExit: (callback: (event: { exitCode: number; signal?: number }) => void) => {
							exitHandler = callback;
							return { dispose: vi.fn() };
						},
					};
				},
			}),
		});
		const started = manager.start(cwd, 80, 24);
		expect(started.running).toBe(true);
		expect(writes).toEqual(["\r"]);
		expect(spawnedArgs).toEqual(expect.arrayContaining(["-i"]));
		expect(spawnedTerm).toBe("xterm-256color");
		manager.write(cwd, "echo hi\r");
		expect(writes).toEqual(["\r", "echo hi\r"]);
		manager.resize(cwd, 120, 40);
		expect(resizes).toEqual([[120, 40]]);
		dataHandler?.("x".repeat(210 * 1024));
		expect(manager.state(cwd).buffer.length).toBe(200 * 1024);
		manager.stop(cwd);
		expect(manager.state(cwd).running).toBe(false);
		expect(broadcasts.length).toBeGreaterThan(1);
	});

	test("reuses a running terminal and replays buffered output", async () => {
		const cwd = await tempDir();
		let dataHandler: ((data: string) => void) | undefined;
		let spawnCount = 0;
		const manager = new TerminalManager({
			broadcast: vi.fn(),
			loadPty: () => ({
				spawn: () => {
					spawnCount++;
					return {
						pid: 123,
						process: "shell",
						write: vi.fn(),
						resize: vi.fn(),
						kill: vi.fn(),
						onData: (callback: (data: string) => void) => {
							dataHandler = callback;
							return { dispose: vi.fn() };
						},
						onExit: () => ({ dispose: vi.fn() }),
					};
				},
			}),
		});
		manager.start(cwd);
		dataHandler?.("hello\n");
		const resumed = manager.start(cwd);
		expect(spawnCount).toBe(1);
		expect(resumed.running).toBe(true);
		expect(resumed.buffer).toBe("hello\n");
	});

	test("reports unavailable optional dependency", async () => {
		const cwd = await tempDir();
		const manager = new TerminalManager({ broadcast: vi.fn(), loadPty: () => null });
		expect(() => manager.start(cwd)).toThrow(TerminalUnavailableError);
	});
});

describe("rpc bridge", () => {
	test("resolves responses and rejects pending requests on exit", async () => {
		const dir = await tempDir();
		const cli = path.join(dir, "fake-cli.js");
		await fsp.writeFile(
			cli,
			`
				process.stdin.setEncoding("utf8");
				let input = "";
				process.stdin.on("data", (chunk) => {
					input += chunk;
					for (;;) {
						const index = input.indexOf("\\n");
						if (index < 0) break;
						const line = input.slice(0, index);
						input = input.slice(index + 1);
						const command = JSON.parse(line);
						if (command.type === "get_messages") process.exit(0);
						if (command.type === "hang") continue;
						process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true }) + "\\n");
					}
				});
			`,
		);
		const bridge = new RpcBridge(cli, [], vi.fn(), dir);
		await expect(bridge.send({ type: "get_state" }, 1000)).resolves.toMatchObject({
			success: true,
			command: "get_state",
		});
		await expect(bridge.send({ type: "get_messages" }, 5000)).rejects.toThrow(/exited/);
	});

	test("times out unanswered requests", async () => {
		const dir = await tempDir();
		const cli = path.join(dir, "fake-hang-cli.js");
		await fsp.writeFile(cli, `process.stdin.resume();`);
		const bridge = new RpcBridge(cli, [], vi.fn(), dir);
		await expect(bridge.send({ type: "get_state" }, 10)).rejects.toThrow(/timed out/);
		bridge.stop();
	});
});

describe("browser smoke guard", () => {
	test("web client preserves the existing browser UI entrypoint", () => {
		const html = fs.readFileSync(path.resolve("web/index.html"), "utf8");
		expect(html).toContain("cdn.tailwindcss.com");
		expect(html).toContain("unpkg.com/react@18");
		expect(html).toContain("/web/app.tsx");
	});
});
