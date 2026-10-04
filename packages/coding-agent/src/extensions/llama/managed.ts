import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { type AddressInfo, createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { expandTildePath, getAgentDir, isBunBinary } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { findHuggingFaceToken } from "./huggingface.ts";

/**
 * Managed llama.cpp: pi starts one shared llama-server router and stops it when no pi process uses it.
 *
 * A detached supervisor process (`pi --internal-llama-supervisor`) owns the router. It listens on a local
 * socket; every pi process that uses the server keeps one connection open, and the operating system closes it
 * when pi exits or crashes, so the number of connections is the reference count. The supervisor stops the
 * router `idleShutdownSeconds` after the last connection closes.
 *
 * Protocol: the supervisor writes one JSON line to each connection, `ready` with the server address or `error`
 * when startup failed. A connection that closes without a line means the supervisor is stopping; the client
 * waits for the socket to disappear and starts a new supervisor. Clients send only `stop`.
 */

/** Hidden CLI flag that turns a pi process into the llama.cpp supervisor. */
export const LLAMA_SUPERVISOR_FLAG = "--internal-llama-supervisor";

const CONNECT_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 120_000;
const SHUTDOWN_GRACE_MS = 10_000;
// The pi process that launched the supervisor connects shortly after. Never idle out before that.
const STARTUP_GRACE_MS = 10_000;
const DEFAULT_IDLE_SHUTDOWN_SECONDS = 30;

const RESERVED_ARGS = new Map<string, string>([
	["--host", "pi binds llama-server to 127.0.0.1"],
	["--port", "pi picks a random free port"],
	["--api-key", "pi generates a random API key"],
	["--api-key-file", "pi generates a random API key"],
	["--models-dir", "use llamaCpp.modelsDir"],
	["-m", "managed llama-server runs in router mode"],
	["--model", "managed llama-server runs in router mode"],
	["-mu", "managed llama-server runs in router mode"],
	["--model-url", "managed llama-server runs in router mode"],
	["-hf", "managed llama-server runs in router mode"],
	["-hfr", "managed llama-server runs in router mode"],
	["--hf-repo", "managed llama-server runs in router mode"],
]);

export interface ManagedLlamaSettings {
	command: string;
	args: string[];
	modelsDir: string;
	idleShutdownSeconds: number;
}

export interface LlamaSupervisorConfig {
	command: string;
	args: string[];
	modelsDir: string;
	idleShutdownMs: number;
	hfToken?: string;
}

export interface ManagedLlamaServerInfo {
	url: string;
	apiKey: string;
	modelsDir: string;
	logPath: string;
}

type SupervisorMessage = { type: "ready"; server: ManagedLlamaServerInfo } | { type: "error"; message: string };

/** Read `llamaCpp` from global settings and apply defaults. Throws on invalid values. */
export function loadManagedLlamaSettings(agentDir: string = getAgentDir()): ManagedLlamaSettings {
	const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false }).getLlamaCppSettings();
	const command = settings.command ?? "llama-server";
	if (typeof command !== "string" || !command.trim()) throw new Error("llamaCpp.command must be a non-empty string");
	const args = settings.args ?? [];
	if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
		throw new Error("llamaCpp.args must be an array of strings");
	}
	for (const arg of args) {
		const reason = RESERVED_ARGS.get(arg.split("=", 1)[0]!);
		if (reason) throw new Error(`llamaCpp.args must not contain ${arg}: ${reason}`);
	}
	const modelsDir = settings.modelsDir ?? join(agentDir, "llama", "models");
	if (typeof modelsDir !== "string" || !modelsDir.trim()) {
		throw new Error("llamaCpp.modelsDir must be a non-empty string");
	}
	const idleShutdownSeconds = settings.idleShutdownSeconds ?? DEFAULT_IDLE_SHUTDOWN_SECONDS;
	if (typeof idleShutdownSeconds !== "number" || !Number.isFinite(idleShutdownSeconds) || idleShutdownSeconds < 0) {
		throw new Error("llamaCpp.idleShutdownSeconds must be a non-negative number");
	}
	return {
		command: expandTildePath(command.trim()),
		args,
		modelsDir: resolve(expandTildePath(modelsDir.trim())),
		idleShutdownSeconds,
	};
}

async function loadSupervisorConfig(agentDir: string): Promise<LlamaSupervisorConfig> {
	const settings = loadManagedLlamaSettings(agentDir);
	const hfToken = await findHuggingFaceToken();
	return {
		command: settings.command,
		args: settings.args,
		modelsDir: settings.modelsDir,
		idleShutdownMs: settings.idleShutdownSeconds * 1000,
		...(hfToken ? { hfToken } : {}),
	};
}

function managedStateDir(agentDir: string): string {
	return join(agentDir, "llama");
}

export function llamaSocketPath(stateDir: string): string {
	if (process.platform === "win32") {
		const hash = createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
		return `\\\\.\\pipe\\pi-llama-${hash}-v1`;
	}
	const path = join(stateDir, "supervisor-v1.sock");
	// sun_path is limited to 104 bytes on macOS and 108 bytes on Linux.
	if (Buffer.byteLength(path) > 100) throw new Error(`llama.cpp supervisor socket path is too long: ${path}`);
	return path;
}

export function llamaLogPath(stateDir: string): string {
	return join(stateDir, "server.log");
}

/** Mirrors llama.cpp's Hugging Face cache lookup (common/hf-cache.cpp), where router downloads are stored. */
export function huggingFaceCacheDir(env: NodeJS.ProcessEnv = process.env): string {
	const entries: [string, string[]][] = [
		["LLAMA_CACHE", []],
		["HF_HUB_CACHE", []],
		["HUGGINGFACE_HUB_CACHE", []],
		["HF_HOME", ["hub"]],
		["XDG_CACHE_HOME", ["huggingface", "hub"]],
		[process.platform === "win32" ? "USERPROFILE" : "HOME", [".cache", "huggingface", "hub"]],
	];
	for (const [name, suffix] of entries) {
		const value = env[name];
		if (value) return join(value, ...suffix);
	}
	return join(homedir(), ".cache", "huggingface", "hub");
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function listenOn(path: string): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(path, () => {
			server.off("error", reject);
			resolve(server);
		});
	});
}

function openSocket(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		socket.once("connect", () => {
			socket.off("error", reject);
			socket.on("error", () => {});
			resolve(socket);
		});
		socket.once("error", reject);
	});
}

/** Listen on the supervisor socket, or return undefined when another live supervisor owns it. */
async function listenExclusive(path: string): Promise<Server | undefined> {
	try {
		return await listenOn(path);
	} catch (error) {
		if (errorCode(error) !== "EADDRINUSE" || process.platform === "win32") return undefined;
	}
	try {
		(await openSocket(path)).destroy();
		return undefined;
	} catch {
		// A socket file nobody accepts on belongs to a crashed supervisor.
	}
	await rm(path, { force: true });
	return listenOn(path).catch(() => undefined);
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

async function isHealthy(url: string, apiKey: string): Promise<boolean> {
	try {
		const response = await fetch(`${url}/health`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(2_000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/** Owns one llama-server router and stops it when no pi process has been connected for the idle delay. */
export class LlamaSupervisor {
	readonly done: Promise<void>;
	private readonly stateDir: string;
	private readonly server: Server;
	private readonly startupGraceMs: number;
	private readonly startedAt = Date.now();
	private readonly apiKey = randomBytes(24).toString("hex");
	private readonly clients = new Set<Socket>();
	private readonly logFd: number;
	private idleShutdownMs = 0;
	private result: SupervisorMessage | undefined;
	private child: ChildProcess | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private stopping: Promise<void> | undefined;
	private resolveDone!: () => void;

	private constructor(stateDir: string, server: Server, startupGraceMs: number) {
		this.stateDir = stateDir;
		this.server = server;
		this.startupGraceMs = startupGraceMs;
		this.logFd = openSync(llamaLogPath(stateDir), "w");
		this.done = new Promise((resolve) => {
			this.resolveDone = resolve;
		});
	}

	/** Start supervising, or return undefined when another supervisor already owns the socket. */
	static async start(
		stateDir: string,
		loadConfig: () => Promise<LlamaSupervisorConfig>,
		startupGraceMs = STARTUP_GRACE_MS,
	): Promise<LlamaSupervisor | undefined> {
		await mkdir(stateDir, { recursive: true, mode: 0o700 });
		const server = await listenExclusive(llamaSocketPath(stateDir));
		if (!server) return undefined;
		const supervisor = new LlamaSupervisor(stateDir, server, startupGraceMs);
		server.on("connection", (socket) => supervisor.accept(socket));
		supervisor.armIdleTimer();
		void supervisor.run(loadConfig);
		return supervisor;
	}

	shutdown(reason: string): Promise<void> {
		this.stopping ??= this.stop(reason);
		return this.stopping;
	}

	private note(message: string): void {
		writeSync(this.logFd, `[pi ${new Date().toISOString()}] ${message}\n`);
	}

	private armIdleTimer(): void {
		clearTimeout(this.idleTimer);
		const delayMs = Math.max(this.idleShutdownMs, this.startupGraceMs - (Date.now() - this.startedAt));
		this.idleTimer = setTimeout(() => void this.shutdown("no pi processes connected"), delayMs);
	}

	private accept(socket: Socket): void {
		socket.on("error", () => {});
		// Closing without a message tells the client to retry once this supervisor is gone.
		if (this.stopping) {
			socket.destroy();
			return;
		}
		this.clients.add(socket);
		clearTimeout(this.idleTimer);
		socket.on("close", () => {
			this.clients.delete(socket);
			if (this.clients.size === 0 && !this.stopping) this.armIdleTimer();
		});
		createInterface({ input: socket }).on("line", (line) => {
			if (line.trim() === "stop") void this.shutdown("stop requested");
		});
		if (this.result) this.send(socket, this.result);
		// A failed supervisor exits once a client received the error, so a retry starts over with fresh settings.
		if (this.result?.type === "error") void this.shutdown("startup failed");
	}

	private send(socket: Socket, message: SupervisorMessage): void {
		socket.write(`${JSON.stringify(message)}\n`);
	}

	private publish(message: SupervisorMessage): void {
		this.result = message;
		for (const socket of this.clients) this.send(socket, message);
	}

	private async run(loadConfig: () => Promise<LlamaSupervisorConfig>): Promise<void> {
		const logPath = llamaLogPath(this.stateDir);
		try {
			const config = await loadConfig();
			this.idleShutdownMs = config.idleShutdownMs;
			await mkdir(config.modelsDir, { recursive: true });
			const url = `http://127.0.0.1:${await freePort()}`;
			await this.startServer(config, url);
			if (this.stopping) return;
			this.note(`llama-server ready at ${url}`);
			this.publish({ type: "ready", server: { url, apiKey: this.apiKey, modelsDir: config.modelsDir, logPath } });
		} catch (error) {
			if (this.stopping) return;
			const message = `${errorMessage(error)}; see ${logPath}`;
			this.note(message);
			this.publish({ type: "error", message });
			await this.stopChild();
			// Without clients, stay up until the idle timer fires so the launching client still receives the error.
			if (this.clients.size > 0) void this.shutdown("startup failed");
		}
	}

	private async startServer(config: LlamaSupervisorConfig, url: string): Promise<void> {
		const port = new URL(url).port;
		const args = [...config.args, "--models-dir", config.modelsDir, "--host", "127.0.0.1", "--port", port];
		this.note(`starting ${[config.command, ...args].join(" ")}`);
		const child = spawn(config.command, args, {
			cwd: this.stateDir,
			env: {
				...process.env,
				...(config.hfToken && !process.env.HF_TOKEN ? { HF_TOKEN: config.hfToken } : {}),
				LLAMA_API_KEY: this.apiKey,
			},
			stdio: ["ignore", this.logFd, this.logFd],
			windowsHide: true,
		});
		this.child = child;
		let failure: string | undefined;
		child.once("error", (error) => {
			failure ??= `Could not start ${config.command}: ${error.message}`;
		});
		child.once("exit", (code, signal) => {
			const lastLine = readFileSync(llamaLogPath(this.stateDir), "utf8").trimEnd().split("\n").at(-1);
			failure ??= `llama-server exited during startup (${signal ?? `code ${code}`}): ${lastLine}`;
			if (this.result?.type !== "ready" || this.stopping) return;
			this.note(`llama-server exited unexpectedly (${signal ?? `code ${code}`})`);
			void this.shutdown("llama-server exited");
		});

		const deadline = Date.now() + READY_TIMEOUT_MS;
		while (!this.stopping && !(await isHealthy(url, this.apiKey))) {
			if (failure) throw new Error(failure);
			if (Date.now() > deadline) throw new Error(`llama-server did not start within ${READY_TIMEOUT_MS / 1000}s`);
			await sleep(100);
		}
	}

	private async stopChild(): Promise<void> {
		const child = this.child;
		if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGTERM");
		const timer = setTimeout(() => {
			this.note(`llama-server pid=${child.pid} did not exit; sending SIGKILL`);
			child.kill("SIGKILL");
		}, SHUTDOWN_GRACE_MS);
		await exited;
		clearTimeout(timer);
	}

	private async stop(reason: string): Promise<void> {
		clearTimeout(this.idleTimer);
		this.note(`stopping: ${reason}`);
		await this.stopChild();
		for (const socket of this.clients) {
			// end() flushes a pending error message before closing; destroy() would drop it.
			socket.end();
			setTimeout(() => socket.destroy(), 1_000).unref();
		}
		// Close the socket last, so a new supervisor cannot start while the old server still runs.
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
		this.note("stopped");
		closeSync(this.logFd);
		this.resolveDone();
	}
}

/** Entry point for `pi --internal-llama-supervisor`, started detached by managed llama.cpp clients. */
export async function runLlamaSupervisorProcess(): Promise<void> {
	process.title = "pi-llama-supervisor";
	const agentDir = getAgentDir();
	const supervisor = await LlamaSupervisor.start(managedStateDir(agentDir), () => loadSupervisorConfig(agentDir));
	if (!supervisor) process.exit(0);
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
		process.on(signal, () => void supervisor.shutdown(`received ${signal}`));
	}
	await supervisor.done;
	process.exit(0);
}

/** Start `pi --internal-llama-supervisor` detached, so it outlives the pi process that started it. */
function launchSupervisorProcess(): void {
	let args: string[];
	if (isBunBinary) {
		args = [LLAMA_SUPERVISOR_FLAG];
	} else {
		const entrypoint = process.argv[1];
		if (!entrypoint) throw new Error("Cannot locate the pi entrypoint to start the llama.cpp supervisor");
		// Keep loader flags (e.g. TypeScript support in source checkouts) but not debugger ports.
		const execArgv = process.execArgv.filter((arg) => !arg.startsWith("--inspect"));
		args = [...execArgv, entrypoint, LLAMA_SUPERVISOR_FLAG];
	}
	const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });
	// Launch failures surface as a connection timeout.
	child.on("error", () => {});
	child.unref();
}

/** Resolve with the first supervisor message, or undefined when the connection closes or the timeout expires. */
function readMessage(socket: Socket, timeoutMs: number): Promise<SupervisorMessage | undefined> {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => resolve(undefined), timeoutMs);
		createInterface({ input: socket }).once("line", (line) => {
			clearTimeout(timeout);
			try {
				resolve(JSON.parse(line) as SupervisorMessage);
			} catch {
				resolve(undefined);
			}
		});
		socket.once("close", () => {
			clearTimeout(timeout);
			resolve(undefined);
		});
	});
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Cancelled"));
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new Error("Cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/**
 * Holds this process's reference on the shared supervisor. The connection stays open until the process exits
 * or `release()` runs; it is unref'd so it never keeps pi alive.
 */
export class ManagedLlamaClient {
	private readonly socketPath: string;
	private readonly launch: () => void;
	private connection: { socket: Socket; server: ManagedLlamaServerInfo } | undefined;
	private pending: Promise<ManagedLlamaServerInfo> | undefined;

	constructor(stateDir: string, launch: () => void = launchSupervisorProcess) {
		this.socketPath = llamaSocketPath(stateDir);
		this.launch = launch;
	}

	/** Connect to the running supervisor, starting one when none is running. */
	acquire(signal?: AbortSignal): Promise<ManagedLlamaServerInfo> {
		if (this.connection) return Promise.resolve(this.connection.server);
		this.pending ??= this.connect().finally(() => {
			this.pending = undefined;
		});
		return raceAbort(this.pending, signal);
	}

	/** Return the running server without starting one or taking a reference. */
	async probe(): Promise<ManagedLlamaServerInfo | undefined> {
		if (this.connection) return this.connection.server;
		const socket = await openSocket(this.socketPath).catch(() => undefined);
		if (!socket) return undefined;
		const message = await readMessage(socket, 2_000);
		socket.destroy();
		return message?.type === "ready" ? message.server : undefined;
	}

	/** Ask the supervisor to stop its server and exit. Other pi processes lose their connection too. */
	async stop(): Promise<void> {
		const socket = this.connection?.socket ?? (await openSocket(this.socketPath).catch(() => undefined));
		this.connection = undefined;
		if (!socket || socket.destroyed) return;
		const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
		socket.write("stop\n");
		await closed;
	}

	release(): void {
		this.connection?.socket.destroy();
		this.connection = undefined;
	}

	private async connect(): Promise<ManagedLlamaServerInfo> {
		const deadline = Date.now() + CONNECT_TIMEOUT_MS;
		let launched = false;
		while (true) {
			let socket: Socket | undefined;
			try {
				socket = await openSocket(this.socketPath);
			} catch (error) {
				const code = errorCode(error);
				if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
				if (!launched) this.launch();
				launched = true;
			}
			if (socket) {
				const message = await readMessage(socket, Math.max(0, deadline - Date.now()));
				if (message?.type === "ready") {
					this.adopt(socket, message.server);
					return message.server;
				}
				socket.destroy();
				if (message?.type === "error") throw new Error(message.message);
				// The supervisor is stopping. Start a new one once its socket is gone.
				launched = false;
			}
			if (Date.now() > deadline) throw new Error("Timed out waiting for the managed llama-server");
			await sleep(socket ? 250 : 100);
		}
	}

	private adopt(socket: Socket, server: ManagedLlamaServerInfo): void {
		const connection = { socket, server };
		this.connection = connection;
		socket.unref();
		socket.once("close", () => {
			if (this.connection === connection) this.connection = undefined;
		});
	}
}

export interface ManagedLlama {
	/** Start or join the shared server and keep a reference until this process exits. */
	acquire(signal?: AbortSignal): Promise<ManagedLlamaServerInfo>;
	/** Return the running server without starting one. */
	probe(): Promise<ManagedLlamaServerInfo | undefined>;
	/** Stop the shared server and start a new one with the current settings. */
	restart(signal?: AbortSignal): Promise<ManagedLlamaServerInfo>;
	/** Check that the configured command runs; returns its version, e.g. "8680 (15f786e65)". */
	verify(signal?: AbortSignal): Promise<string>;
}

export function createManagedLlama(agentDir: string = getAgentDir(), launch?: () => void): ManagedLlama {
	let client: ManagedLlamaClient | undefined;
	const getClient = () => {
		client ??= new ManagedLlamaClient(managedStateDir(agentDir), launch);
		return client;
	};
	return {
		acquire: (signal) => getClient().acquire(signal),
		probe: () => getClient().probe(),
		restart: async (signal) => {
			await getClient().stop();
			return getClient().acquire(signal);
		},
		verify: (signal) => {
			const { command } = loadManagedLlamaSettings(agentDir);
			return new Promise((resolve, reject) => {
				execFile(
					command,
					["--version"],
					{ timeout: 15_000, signal, windowsHide: true },
					(error, stdout, stderr) => {
						if (error) {
							reject(
								new Error(
									`Could not run ${command} --version: ${error.message}. Install llama.cpp or set llamaCpp.command in settings.json`,
								),
							);
							return;
						}
						const output = `${stdout}\n${stderr}`;
						const version = output.split("\n").find((line) => line.startsWith("version:"));
						resolve(version ? version.slice("version:".length).trim() : output.trim());
					},
				);
			});
		},
	};
}
