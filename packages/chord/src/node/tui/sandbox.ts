// The terminal's sandbox (slice 11 §4, decision "Slice 11, P8"; fix round 2: a child process, as the owner decided
// after the worker thread was escaped through its shared realm): a Node child process of the launcher's binary.
// - The operating system's side: its stdin, stdout and stderr are pipes to the launcher (never the terminal: no
//   descriptor of the child is a TTY), its environment empty, its directory a private one holding only the bootstrap;
//   Node's permission model with nothing allowed but reading the bootstrap (no other file read, no write, no network,
//   no child processes, no workers, no addons, no inspector, no WASI) and `node:sqlite` removed
//   (`--no-experimental-sqlite`: SQLite opens files past the permission model). An escape from the JavaScript layer
//   reaches no terminal, no file, no socket, no launcher memory or token.
// - The JavaScript side, a second layer: downloaded code (the base bundle, a CommonJS script; the plugins' registered
//   scripts) is only evaluated by the bootstrap (`vm.Script` with no dynamic import callback, so `import()` throws),
//   with a `require` answering the allowed builtins only (`SANDBOX_BUILTINS`); `process` is a substitute with
//   `SANDBOX_PROCESS` only. The bootstrap keeps its own references to what it uses before any downloaded code runs.
// Messages go both ways as length-prefixed binary frames (`pipe.ts`). Known gaps, each needing the JavaScript layer
// broken first unless noted: the child may signal processes of the same user (Node has no permission for signals; the
// launcher ignores SIGUSR1, which would open its inspector), read machine details (`os`), learn whether any path exists
// (`require.resolve` fails one way for a file that exists, another for one that does not: Opus E13), and allocate
// memory outside its heap (no limit without a shell's `ulimit`; only the child dies). Needs Node 26.5.1 or later.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeStart, LauncherMessage, SandboxMessage } from "../../tui/bridge.ts";
import { FrameReader, launcherFrame, MAX_PIPE_FRAME, startFrame } from "./pipe.ts";

/** The largest base bundle a sandbox runs: 8 MiB. */
export const MAX_BUNDLE = 8 * 1024 * 1024;

/**
 * The builtins code in the sandbox may `require`, each computation in memory without I/O, descriptors or machine
 * details: bytes and text (`buffer`, `string_decoder`, `punycode`, `querystring`), events and streams in memory
 * (`events`, `stream` and its submodules), formatting and type checks (`util`, `util/types`), URL and path strings
 * (`url`, `path`), timers, assertions, hashing and randomness (`crypto`: no keys from files, no network) and compression
 * in memory (`zlib`). Not `fs`, `tty`, `net`, `dgram`, `dns`, `http`, `https`, `http2`, `tls`, `child_process`,
 * `cluster`, `worker_threads`, `sqlite`, `inspector`, `vm`, `v8`, `os`, `module`, `process`, `perf_hooks`, `wasi`,
 * `repl`, `readline`, `trace_events` or anything else.
 */
export const SANDBOX_BUILTINS: readonly string[] = [
	"assert",
	"assert/strict",
	"buffer",
	"crypto",
	"events",
	"path",
	"path/posix",
	"path/win32",
	"punycode",
	"querystring",
	"stream",
	"stream/consumers",
	"stream/promises",
	"stream/web",
	"string_decoder",
	"timers",
	"timers/promises",
	"url",
	"util",
	"util/types",
	"zlib",
];

/**
 * The sandbox's `process`: a frozen plain object in place of Node's (no event emitter, so no prototype shared with
 * Node's internals leads back to the real one). Its properties, each harmless: which Node it is (`arch`, `platform`,
 * `version`, `versions`, `release`), time (`nextTick`, `hrtime`, `uptime`), ending the sandbox (`exit`), the permission
 * checks (`permission`), the allowed builtins (`getBuiltinModule`), fixed values (`env` empty, `argv`, `argv0`,
 * `execArgv`, `execPath`, `title`, `cwd` `/`), `stdout` (to the terminal through the bridge) and `stderr` (dropped),
 * and listener calls that keep nothing (`on`, `once`, `off`, `addListener`, `removeListener`, `removeAllListeners`,
 * `emit`, `emitWarning`, `listenerCount`, `listeners`). Not `binding`, `_linkedBinding`, `dlopen`, `_rawDebug`, `kill`,
 * `execve`, `chdir`, `abort`, `reallyExit`, `stdin`, `openStdin`, `report`, `pid`, `ppid`, `config`, the user and group
 * calls, `loadEnvFile`, `moduleLoadList`, resource and handle listings or any other.
 */
export const SANDBOX_PROCESS: readonly string[] = [
	"addListener",
	"arch",
	"argv",
	"argv0",
	"cwd",
	"emit",
	"emitWarning",
	"env",
	"execArgv",
	"execPath",
	"exit",
	"getBuiltinModule",
	"hrtime",
	"listenerCount",
	"listeners",
	"nextTick",
	"off",
	"on",
	"once",
	"permission",
	"platform",
	"release",
	"removeAllListeners",
	"removeListener",
	"stderr",
	"stdout",
	"title",
	"uptime",
	"version",
	"versions",
];

/**
 * The child's Node flags for its script `script`: the permission model allowing only reading that file, no SQLite, a
 * 96 MiB heap. Exported for the tests of the operating system's layer alone.
 */
export function sandboxFlags(script: string): string[] {
	return ["--permission", `--allow-fs-read=${script}`, "--no-experimental-sqlite", "--max-old-space-size=96", script];
}

/** The bootstrap's file in the sandbox's directory: a script, not `-e`, which puts every builtin on `globalThis`. */
export const BOOTSTRAP_FILE = "bootstrap.cjs";

/** The most bytes waiting for the sandbox to read them before it counts as stuck: 64 MiB. */
const MAX_UNREAD = 64 * 1024 * 1024;

/** Throws unless this Node is 26.5.1 or later, the Node the sandbox's permissions were checked on. */
export function requireSandboxNode(version: string = process.versions.node): void {
	const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
	if (major > 26 || (major === 26 && (minor > 5 || (minor === 5 && patch >= 1)))) return;
	throw new Error(`the terminal client needs Node 26.5.1 or later for its sandbox (this is Node ${version})`);
}

/**
 * The child's environment: empty, but for `LD_LIBRARY_PATH` when the launcher has one: the launcher needed it to run
 * this same binary (a Node built against libraries outside the system's paths), and the server cannot influence it.
 */
export function sandboxEnvironment(): Record<string, string> {
	const libraries = process.env.LD_LIBRARY_PATH;
	return libraries === undefined ? {} : { LD_LIBRARY_PATH: libraries };
}

/** A running sandbox: messages both ways, and its end. */
export class Sandbox {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #directory: string;
	readonly #onMessage: (message: SandboxMessage) => void;
	readonly #onEnd: (reason: string) => void;
	readonly #reader = new FrameReader();
	readonly #exited: Promise<void>;
	#ended = false;
	/** Whether the child has sent anything: its bootstrap was read, so the file goes. */
	#running = false;

	/**
	 * Starts a sandbox running the base bundle `source` (a CommonJS script) with `start` on its bridge; `onMessage` gets
	 * what it sends, `onEnd` its end (an exit, a crash, its memory limit, a malformed frame), once.
	 */
	static async start(
		source: string,
		start: BridgeStart,
		onMessage: (message: SandboxMessage) => void,
		onEnd: (reason: string) => void,
	): Promise<Sandbox> {
		requireSandboxNode();
		if (Buffer.byteLength(source) > MAX_BUNDLE) throw new Error("terminal: the base bundle exceeds 8 MiB");
		// Node resolves its entry before reading it; a symlinked ancestor would need a broader file grant.
		const directory = await realpath(await mkdtemp(join(tmpdir(), "chord-tui-")));
		await writeFile(join(directory, BOOTSTRAP_FILE), BOOTSTRAP);
		const sandbox = new Sandbox(directory, onMessage, onEnd);
		sandbox.#write(startFrame(start, source));
		return sandbox;
	}

	private constructor(
		directory: string,
		onMessage: (message: SandboxMessage) => void,
		onEnd: (reason: string) => void,
	) {
		this.#directory = directory;
		this.#onMessage = onMessage;
		this.#onEnd = onEnd;
		this.#child = spawn(process.execPath, sandboxFlags(join(directory, BOOTSTRAP_FILE)), {
			stdio: ["pipe", "pipe", "pipe"],
			env: sandboxEnvironment(),
			cwd: directory,
			windowsHide: true,
		});
		this.#exited = new Promise((resolve) => this.#child.once("close", () => resolve()));
		this.#child.stdout.on("data", (chunk: Buffer) => this.#read(chunk));
		// Dropped: the sandbox writes only through the bridge, and the terminal is the launcher's.
		this.#child.stderr.resume();
		// A write after the child ended fails here; its end is reported by `close`.
		this.#child.stdin.on("error", () => {});
		this.#child.on("error", (error) => this.#end(`the terminal client failed: ${error.message}`));
		this.#child.on("close", () => {
			this.#end("the terminal client exited");
			void rm(this.#directory, { recursive: true, force: true });
		});
	}

	/** Sends `message` to the sandbox; a sandbox not reading what it was sent is ended. */
	post(message: LauncherMessage): void {
		if (!this.#ended) this.#write(launcherFrame(message));
	}

	/** Ends the sandbox and waits for its exit. */
	async terminate(): Promise<void> {
		this.#ended = true;
		this.#child.kill("SIGKILL");
		await this.#exited;
	}

	#write(frame: Buffer): void {
		if (this.#child.stdin.writableLength + frame.length > MAX_UNREAD + MAX_PIPE_FRAME) {
			this.#fail("the terminal client stopped reading");
			return;
		}
		this.#child.stdin.write(frame);
	}

	/** The sandbox's output: its messages, each passed on; a malformed one ends the sandbox. */
	#read(chunk: Buffer): void {
		if (this.#ended) return;
		if (!this.#running) {
			this.#running = true;
			// Read once at the start; a launcher killed later leaves at most an empty directory.
			void rm(join(this.#directory, BOOTSTRAP_FILE), { force: true });
		}
		let messages: SandboxMessage[];
		try {
			messages = this.#reader.push(chunk);
		} catch (error) {
			this.#fail((error as Error).message);
			return;
		}
		for (const message of messages) if (!this.#ended) this.#onMessage(message);
	}

	#fail(reason: string): void {
		this.#child.kill("SIGKILL");
		this.#end(reason);
	}

	#end(reason: string): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#onEnd(reason);
	}
}

/**
 * The trusted bootstrap (strict CommonJS, the child's main script). Before any downloaded code runs it keeps its own
 * references to what it uses (so code that changes shared prototypes later cannot steer it), closes the file system's
 * functions, shadows the real `process`'s listener calls, puts the substitute `process` in place, removes the module
 * globals and leaves the bridge on `globalThis`; then it waits for the launcher's start frame and evaluates the base
 * bundle through its own `require`. Frames as in `pipe.ts`.
 */
const BOOTSTRAP = `"use strict";
const real = process;
const getBuiltin = real.getBuiltinModule;
const apply = Reflect.apply;
const uncurry = Function.prototype.call.bind(Function.prototype.bind, Function.prototype.call);
const parse = JSON.parse;
const stringify = JSON.stringify;
const freeze = Object.freeze;
const define = Object.defineProperty;
const BufferFrom = Buffer.from;
const BufferAlloc = Buffer.allocUnsafe;
const BufferConcat = Buffer.concat;
const readUInt32BE = uncurry(Buffer.prototype.readUInt32BE);
const writeUInt32BE = uncurry(Buffer.prototype.writeUInt32BE);
const bufferText = uncurry(Buffer.prototype.toString);
const subarray = uncurry(Buffer.prototype.subarray);
const copyBytes = uncurry(Buffer.prototype.copy);
const isUint8Array = (value) => value instanceof Uint8Array;
const builtin0 = (id) => apply(getBuiltin, real, [id]);
const Script = builtin0("node:vm").Script;
const runInThisContext = uncurry(Script.prototype.runInThisContext);
const nextTick = real.nextTick;
const hrtime = real.hrtime;
const hrtimeBigint = real.hrtime.bigint;
const uptime = real.uptime;
const exit = real.exit;
const input = real.stdin;
const output = real.stdout;
const writeOutput = uncurry(output.write);
const onInput = uncurry(input.on);
const MAX_FRAME = ${MAX_PIPE_FRAME};
const deny = () => {
	throw new Error("unavailable in the terminal's sandbox");
};

// The file system's functions closed: the permission model guards paths, not the pipes' descriptors.
for (const facade of [builtin0("node:fs"), builtin0("node:fs/promises")]) {
	for (const name of Object.keys(facade)) {
		if (typeof facade[name] === "function") define(facade, name, { value: deny, writable: false, configurable: false, enumerable: true });
	}
}
const v8 = builtin0("node:v8");
for (const name of ["writeHeapSnapshot", "getHeapSnapshot", "queryObjects", "setFlagsFromString", "takeCoverage", "startCpuProfile", "startHeapProfile"]) {
	if (typeof v8[name] === "function") v8[name] = deny;
}
builtin0("node:module").syncBuiltinESMExports();
// Node emits on its own process (warnings among them): its listener calls are its own properties, not the shared
// prototype's, which downloaded code may change.
const emitter = builtin0("node:events").EventEmitter.prototype;
for (const name of Object.getOwnPropertyNames(emitter)) {
	if (name !== "constructor" && typeof emitter[name] === "function") define(real, name, { value: emitter[name], writable: false, configurable: false });
}
// Node reads properties its process does not have (noDeprecation, throwDeprecation, traceDeprecation,
// traceProcessWarnings, channel, connected, …): such a read goes up the prototype chain, where a getter would get the
// real process as its this (Opus E7: Buffer(1) warns, and the warning reads process.noDeprecation). Every prototype of
// the chain, Object.prototype included, takes no new property and keeps its own ones, so no getter and no other
// prototype gets in. Not frozen: Node assigns over prototype fields (\`this._events ??= {}\`).
for (let prototype = Object.getPrototypeOf(real); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
	for (const key of Reflect.ownKeys(prototype)) define(prototype, key, { configurable: false });
	Object.preventExtensions(prototype);
}

// The allowed builtins, by name with or without "node:"; looked up in an object of no prototype.
const allowed = Object.create(null);
for (const name of ${JSON.stringify(SANDBOX_BUILTINS)}) allowed[name] = true;
const builtin = (id) => {
	if (typeof id !== "string") throw new Error("unavailable in the terminal's sandbox");
	const name = id.length > 5 && id[0] === "n" && id[1] === "o" && id[2] === "d" && id[3] === "e" && id[4] === ":" ? id.slice(5) : id;
	if (typeof name !== "string" || allowed[name] !== true) throw new Error(id + ": unavailable in the terminal's sandbox");
	return builtin0("node:" + name);
};

// Frames out: the message's header as JSON, its write text or socket bytes as the body.
const send = (message) => {
	const kind = message.kind;
	let header;
	let body;
	if (kind === "write") {
		const data = String(message.data);
		// Refused before it is copied: a huge string costs no buffer of its size.
		if (data.length > MAX_FRAME) throw new RangeError("the terminal's bridge takes frames of at most 17 MiB");
		header = { kind };
		body = BufferFrom(data);
	} else if (kind === "socket_send") {
		if (!isUint8Array(message.bytes)) throw new TypeError("socket_send: bytes expected");
		header = { kind, socket: message.socket };
		body = message.bytes;
	} else {
		header = message;
	}
	const json = BufferFrom(stringify(header));
	const length = 4 + json.length + (body === undefined ? 0 : body.length);
	if (length > MAX_FRAME) throw new RangeError("the terminal's bridge takes frames of at most 17 MiB");
	const prefix = BufferAlloc(8);
	writeUInt32BE(prefix, length, 0);
	writeUInt32BE(prefix, json.length, 4);
	writeOutput(output, BufferConcat(body === undefined ? [prefix, json] : [prefix, json, body]));
};

// The substitute process.
const stdout = freeze({ isTTY: false, write: (data) => (send({ kind: "write", data: String(data) }), true) });
const listening = (name) => [name, function () { return fake; }];
const fake = freeze({
	arch: real.arch,
	platform: real.platform,
	version: real.version,
	versions: freeze({ ...real.versions }),
	release: freeze({ ...real.release }),
	nextTick: (...args) => apply(nextTick, real, args),
	hrtime: Object.assign((...args) => apply(hrtime, real, args), { bigint: () => apply(hrtimeBigint, real, []) }),
	uptime: () => apply(uptime, real, []),
	exit: (code) => apply(exit, real, [code]),
	permission: real.permission,
	env: freeze({}),
	argv: freeze(["node"]),
	argv0: "node",
	execArgv: freeze([]),
	execPath: "node",
	title: "node",
	cwd: () => "/",
	getBuiltinModule: builtin,
	stdout,
	stderr: freeze({ isTTY: false, write: () => true }),
	...Object.fromEntries(["on", "once", "off", "addListener", "removeListener", "removeAllListeners"].map(listening)),
	emit: () => false,
	emitWarning: () => {},
	listenerCount: () => 0,
	listeners: () => [],
});
define(globalThis, "process", { value: fake, writable: false, configurable: false, enumerable: false });
for (const name of ["BroadcastChannel", "localStorage", "sessionStorage"]) delete globalThis[name];

// Downloaded code runs only through here, with options of no prototype (nothing read from Object.prototype).
const evaluate = (text, filename) => {
	const options = Object.create(null);
	options.filename = String(filename);
	return runInThisContext(new Script(String(text), options));
};

// Frames in: the first is the start (the bridge's start and the base bundle), the rest the launcher's messages.
let listener;
let started = false;
// Unread bytes: one buffer, grown by doubling, each byte copied in once.
let pending = BufferAlloc(64 * 1024);
let start = 0;
let end = 0;
const received = (payload) => {
	const headerLength = readUInt32BE(payload, 0);
	const header = parse(bufferText(payload, "utf8", 4, 4 + headerLength));
	const body = subarray(payload, 4 + headerLength);
	if (!started) {
		started = true;
		run(header.start, bufferText(body, "utf8"));
		return;
	}
	if (header.kind === "input") header.data = bufferText(body, "utf8");
	else if (header.kind === "socket_message" || header.kind === "attached") header.bytes = new Uint8Array(body);
	if (listener !== undefined) listener(header);
};
onInput(input, "data", (chunk) => {
	if (end + chunk.length > pending.length) {
		const unread = end - start;
		const target = unread + chunk.length <= pending.length ? pending : BufferAlloc(Math.max(unread + chunk.length, pending.length * 2));
		copyBytes(pending, target, 0, start, end);
		pending = target;
		start = 0;
		end = unread;
	}
	copyBytes(chunk, pending, end);
	end += chunk.length;
	while (end - start >= 4) {
		const length = readUInt32BE(pending, start);
		if (length > MAX_FRAME) apply(exit, real, [70]);
		if (end - start < 4 + length) break;
		// A copy: the buffer is reused, and what the frame carries is kept by the sandbox.
		const payload = BufferAlloc(length);
		copyBytes(pending, payload, 0, start + 4, start + 4 + length);
		start += 4 + length;
		received(payload);
	}
	if (start === end) start = end = 0;
});
onInput(input, "end", () => apply(exit, real, [0]));
const run = (start, source) => {
	globalThis.chordBridge = freeze({
		start: freeze(start),
		send,
		onMessage: (next) => {
			listener = next;
		},
		evaluate,
	});
	try {
		const base = { exports: {} };
		evaluate("(function (require, module, exports) {" + source + "\\n})", "chord-base.js")(builtin, base, base.exports);
	} catch (error) {
		send({ kind: "failed", message: String(error && error.message) });
	}
};
`;
