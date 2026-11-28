// Tests of process locks (slice 10 §3): one holder at a time, a waiter taking the lock when the holder releases it
// (told by its connection's close, no polling), a waiter's abort, the state, a holder's death, a stopped or busy
// holder, racing takes, the location, children, and on macOS and the BSDs the lock directory and the legacy check
// (decision "Process locks are kernel locks on macOS and the BSDs"). Other holders are fixture processes.

import { createHook } from "node:async_hooks";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { getEventListeners } from "node:events";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	renameSync,
	rmdirSync,
	statSync,
} from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "../../../src/context/index.ts";
import { processLock, processLockState } from "../../../src/node/workers/index.ts";
import { sameDirectory } from "../../../src/node/workers/lock.ts";

const HOLDER = fileURLToPath(new URL("../fixtures/workers/lock-holder.ts", import.meta.url));

const LEGACY_HOLDER = fileURLToPath(new URL("../fixtures/workers/legacy-holder.ts", import.meta.url));

/** Locks are flocks on directories here. */
const FLOCK = ["darwin", "freebsd", "openbsd", "netbsd"].includes(process.platform);

/** Locks are abstract sockets here, whose state is read by a connect. */
const ABSTRACT = ["linux", "android"].includes(process.platform);

/** This platform has process locks (not AIX or SunOS). */
const LOCKS = FLOCK || ABSTRACT || process.platform === "win32";

/** `lock.ts` as a stack names it, with either separator (a `file:` URL on Windows). */
const LOCK_SOURCE = "/src/node/workers/lock.ts";

/** A fixture process, once it said `held`. */
type Spawned = { readonly process: ChildProcess; next(): Promise<string> };

const started = new Set<number>();

/** Every lock name a case used, taken and released after it: a killed holder leaves files in the shared lock base. */
const names = new Set<string>();

/** Files a case left outside the lock base (a legacy holder's socket file). */
const files = new Set<string>();

afterEach(async () => {
	for (const pid of started) kill(pid, "SIGKILL");
	started.clear();
	// Cleared first: a name still held fails its own case, not every later one.
	const used = [...names];
	names.clear();
	for (const name of used) {
		await (await processLock(name, withAbortSignal(AbortSignal.timeout(5000), context))).release();
	}
	for (const file of files) await rm(file, { force: true });
	files.clear();
});

describe.skipIf(!LOCKS)("processLock", () => {
	it("makes a second taker wait until the holder releases, then takes it", async () => {
		const name = `chord-test-lock-${process.pid}-${Date.now()}`;
		const first = await processLock(name, context);
		let taken = false;
		const second = processLock(name, context).then((lock) => {
			taken = true;
			return lock;
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(taken).toBe(false);
		const released = Date.now();
		await first.release();
		await (await second).release();
		expect(taken).toBe(true);
		expect(Date.now() - released).toBeLessThan(100);
	});

	it("stops waiting when the waiter's context aborts", async () => {
		const name = `chord-test-lock-abort-${process.pid}-${Date.now()}`;
		const held = await processLock(name, context);
		const abort = new AbortController();
		const waiting = processLock(name, withAbortSignal(abort.signal, context));
		abort.abort(new Error("gave up"));
		await expect(waiting).rejects.toThrow("gave up");
		expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
		await held.release();
		await (await processLock(name, context)).release();
	});

	it("makes a second taker wait on one connection, with no timer, until the holder releases", async () => {
		const name = lockName("wait");
		const first = await processLock(name, context);
		const waiting = new AbortController();
		const activity = lockActivity();
		let taken = false;
		const second = processLock(name, withAbortSignal(waiting.signal, context)).then((lock) => {
			taken = true;
			return lock;
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(taken).toBe(false);
			expect([activity.connects(), activity.timers()]).toEqual([1, 0]);
			await first.release();
			await (await second).release();
			// The connects after the release are the legacy check's (macOS, the BSDs): only timers are counted.
			expect(activity.timers()).toBe(0);
		} finally {
			activity.stop();
			waiting.abort();
			await first.release();
			await second.then(
				(lock) => lock.release(),
				() => {},
			);
		}
	});

	it("releases once however often it is asked: a descriptor opened after the first release stays open", async () => {
		const lock = await processLock(lockName("twice"), context);
		await lock.release();
		const fd = openSync(tmpdir(), constants.O_RDONLY);
		try {
			await lock.release();
			expect(() => fstatSync(fd)).not.toThrow();
		} finally {
			closeSync(fd);
		}
	});

	// Only macOS and the BSDs have a callback in a release: the exit hook's removal.
	it.skipIf(!FLOCK)("is one release also when a release is asked from inside the first one's callbacks", async () => {
		const lock = await processLock(lockName("reentry"), context);
		let inner: Promise<void> | undefined;
		const removed = (event: string | symbol): void => {
			if (event === "exit") inner ??= lock.release();
		};
		process.on("removeListener", removed);
		let outer: Promise<void>;
		try {
			outer = lock.release();
		} finally {
			process.off("removeListener", removed);
		}
		expect(inner).toBe(outer);
		await outer;
	});

	// `net.client.socket`'s subscribers run inside `connect`: the abort lands there.
	it("rejects a waiter aborted while its connect runs, and leaves no listener", async () => {
		const name = lockName("connect-abort");
		const held = await processLock(name, context);
		const abort = new AbortController();
		const stop = (): void => abort.abort(new Error("gave up"));
		subscribe("net.client.socket", stop);
		try {
			await expect(processLock(name, withAbortSignal(abort.signal, context))).rejects.toThrow("gave up");
			expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
		} finally {
			unsubscribe("net.client.socket", stop);
			await held.release();
		}
	});

	it("rejects a take and a probe aborted during the lookup of the lock's address", async () => {
		const name = lockName("lookup");
		for (const call of [processLock, processLockState] as const) {
			const abort = new AbortController();
			const asked = call(name, withAbortSignal(abort.signal, context));
			abort.abort(new Error("gave up"));
			await expect(asked).rejects.toThrow("gave up");
			expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
		}
		expect(await processLockState(name, context)).toBe("free");
	});
});

describe.skipIf(!LOCKS)("processLockState", () => {
	it("reads free before a take and after the release, held meanwhile in this process and in another", async () => {
		const name = lockName("state");
		expect(await processLockState(name, context)).toBe("free");
		const lock = await processLock(name, context);
		expect(await processLockState(name, context)).toBe("held");
		await lock.release();
		expect(await processLockState(name, context)).toBe("free");
		const other = await holder(name, ["stay"]);
		expect(await processLockState(name, context)).toBe("held");
		await killed(other.process);
		expect(await processLockState(name, context)).toBe("free");
	});

	// Only here does a probe connect.
	it.skipIf(!ABSTRACT)("rejects a probe aborted while its connect runs, and leaves no listener", async () => {
		const name = lockName("state-abort");
		const held = await processLock(name, context);
		const abort = new AbortController();
		const stop = (): void => abort.abort(new Error("gave up"));
		subscribe("net.client.socket", stop);
		try {
			await expect(processLockState(name, withAbortSignal(abort.signal, context))).rejects.toThrow("gave up");
			expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
		} finally {
			unsubscribe("net.client.socket", stop);
			await held.release();
		}
	});
});

describe.skipIf(!LOCKS)("a holder's death", () => {
	// Neither signal runs the holder's exit hooks.
	it.each(["SIGKILL", "SIGTERM"] as const)(
		"by %s frees the lock at once: free, and a taker takes it within 200 ms",
		async (signal) => {
			const name = lockName(`death-${signal}`);
			const other = await holder(name, ["stay"]);
			await killed(other.process, signal);
			expect(await processLockState(name, context)).toBe("free");
			const taken = Date.now();
			await (await processLock(name, withAbortSignal(AbortSignal.timeout(1000), context))).release();
			expect(Date.now() - taken).toBeLessThan(200);
		},
	);

	it("wakes the waiters already waiting on one connection each, with no timer, when the holder dies", async () => {
		const name = lockName("wake");
		const other = await holder(name, ["stay"]);
		const waiting = new AbortController();
		const activity = lockActivity();
		const waiters = [1, 2].map(() => processLock(name, withAbortSignal(waiting.signal, context)));
		try {
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect([activity.connects(), activity.timers()]).toEqual([2, 0]);
			activity.stop();
			await killed(other.process);
			const first = await Promise.race(waiters);
			await first.release();
			for (const lock of await Promise.all(waiters)) await lock.release();
		} finally {
			activity.stop();
			waiting.abort();
			for (const waiter of waiters)
				await waiter.then(
					(lock) => lock.release(),
					() => {},
				);
		}
	});
});

// A full backlog refuses connects (macOS: the 129th). Not on Windows: no SIGSTOP, and a pipe has no backlog to fill.
describe.skipIf(!LOCKS || process.platform === "win32")("a stopped or busy holder", () => {
	it("keeps the lock when stopped (SIGSTOP), past 400 refused connects and 200 probes", async () => {
		const name = lockName("stopped");
		const other = await holder(name, ["stay"]);
		other.process.kill("SIGSTOP");
		await expectKept(name);
		other.process.kill("SIGCONT");
	});

	it("keeps the lock while its event loop is blocked, past 400 refused connects and 200 probes", async () => {
		const name = lockName("busy");
		await holder(name, ["block", "10000"]);
		await expectKept(name);
	});
});

describe.skipIf(!LOCKS)("racing takes", () => {
	it("never makes two holders, nor a holder its waiters cannot reach: three processes taking 300 times each while this one probes", async () => {
		const name = lockName("race");
		const directory = await mkdtemp(join(tmpdir(), "chord-lock-race-"));
		try {
			const marker = join(directory, "held");
			const socket = FLOCK ? lockSocket(name) : "";
			const racers = await Promise.all([1, 2, 3].map(() => holder(name, ["cycle", "300", marker, socket])));
			const cycled = Promise.all(racers.map((racer) => racer.next()));
			let probes = 0;
			let done = false;
			// A racer that crashed ends the probes at once.
			const stop = (): void => {
				done = true;
			};
			cycled.then(stop, stop);
			while (!done) {
				expect(["held", "free"]).toContain(await processLockState(name, context));
				probes++;
				// A flock probe does no I/O: without a pause this loop would starve the racers.
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			expect(await cycled).toEqual(["cycled 0", "cycled 0", "cycled 0"]);
			expect(probes).toBeGreaterThan(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 60_000);
});

// Its race sits inside one `open(2)` and cannot be forced: the check itself.
describe.skipIf(process.platform === "win32")("the inode check (`sameDirectory`)", () => {
	it("refuses a directory replaced or removed after it was opened, and accepts the one still named", async () => {
		const parent = await mkdtemp(join(tmpdir(), "chord-lock-inode-"));
		try {
			const path = join(parent, "lock");
			mkdirSync(path);
			const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
			try {
				expect(sameDirectory(fd, path)).toBe(true);
				renameSync(path, join(parent, "removed"));
				mkdirSync(path);
				expect(sameDirectory(fd, path)).toBe(false);
				rmdirSync(path);
				expect(sameDirectory(fd, path)).toBe(false);
			} finally {
				closeSync(fd);
			}
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});
});

describe.skipIf(!LOCKS)("the location", () => {
	it.each([
		// No usable `PATH`: `getconf` is called by its absolute path.
		["another TMPDIR", (directory: string) => ({ ...process.env, TMPDIR: `${directory}/`, PATH: "/nonexistent" })],
		// Node on Windows does not start without `SystemRoot`.
		[
			"an empty environment (env -i)",
			() => (process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
		],
	])("is the same whatever the environment: a holder with %s is seen and waited for", async (_what, env) => {
		const name = lockName("environment");
		const directory = await mkdtemp(join(tmpdir(), "chord-lock-env-"));
		try {
			const other = await holder(name, ["stay"], env(directory));
			expect(await processLockState(name, context)).toBe("held");
			await expect(processLock(name, withAbortSignal(AbortSignal.timeout(200), context))).rejects.toHaveProperty(
				"name",
				"TimeoutError",
			);
			await killed(other.process);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform !== "darwin")(
		"is the user temporary directory macOS fixes, never under /tmp, with a socket path that fits sun_path",
		async () => {
			const name = lockName("darwin");
			const lock = await processLock(name, context);
			const socket = lockSocket(name);
			expect(existsSync(socket)).toBe(true);
			expect(socket.startsWith(`${userTemp()}chord-lock/`)).toBe(true);
			expect(socket.startsWith("/tmp/") || socket.startsWith("/private/tmp/")).toBe(false);
			expect(statSync(`${userTemp()}chord-lock`).mode & 0o777).toBe(0o700);
			// Every lock's path has this length: the key's is fixed.
			expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
			await lock.release();
		},
	);
});

describe.skipIf(!LOCKS)("children of a holder", () => {
	it("inherit no lock: a holder killed while its forked and spawned children live frees it", async () => {
		const name = lockName("children");
		const other = await holder(name, ["children"]);
		const [, ...children] = (await other.next()).split(" ").map(Number);
		expect(children).toHaveLength(2);
		for (const pid of children) started.add(pid);
		await killed(other.process);
		expect(await processLockState(name, context)).toBe("free");
		await (await processLock(name, withAbortSignal(AbortSignal.timeout(1000), context))).release();
		expect(children.every(alive)).toBe(true);
	});
});

describe.skipIf(!FLOCK)("lock directories (macOS, the BSDs)", () => {
	it("a release removes its directory; a holder killed by a signal leaves it, and the next holder takes it as it is", async () => {
		const name = lockName("directory");
		const lock = await processLock(name, context);
		expect(existsSync(lockSocket(name))).toBe(true);
		await lock.release();
		expect(existsSync(lockDirectory(name))).toBe(false);
		const other = await holder(name, ["stay"]);
		await killed(other.process);
		expect(existsSync(lockSocket(name))).toBe(true);
		await (await processLock(name, withAbortSignal(AbortSignal.timeout(1000), context))).release();
		expect(existsSync(lockDirectory(name))).toBe(false);
	});

	it("throws a connect error it does not know instead of retrying it: a lock directory nobody may search", async () => {
		const name = lockName("unsearchable");
		const held = await processLock(name, context);
		chmodSync(lockDirectory(name), 0o600);
		try {
			await expect(processLock(name, withAbortSignal(AbortSignal.timeout(1000), context))).rejects.toHaveProperty(
				"code",
				"EACCES",
			);
		} finally {
			chmodSync(lockDirectory(name), 0o700);
			await held.release();
		}
	});

	it("an exit without a release removes the directory too", async () => {
		const name = lockName("exit");
		const exiting = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", HOLDER, name, "exit"]);
		expect(await new Promise((resolve) => exiting.once("exit", resolve))).toBe(0);
		expect(existsSync(lockDirectory(name))).toBe(false);
	});

	it("reads free beside another probe's shared flock", async () => {
		const name = lockName("shared");
		const directory = lockDirectory(name);
		mkdirSync(directory, { mode: 0o700 });
		// 0x10: `O_SHLOCK`, as a probe opens it.
		const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK | 0x10);
		try {
			expect(await processLockState(name, context)).toBe("free");
		} finally {
			closeSync(fd);
			rmdirSync(directory);
		}
	});
});

describe.skipIf(!FLOCK)("the previous release's holders (the legacy check, for one release)", () => {
	// The old socket file is under `TMPDIR` when that fits sun_path, else in `/tmp/chord-lock-<uid>`. `tmpdir()` reads
	// `TMPDIR` at each call, so the case sets it for both processes.
	it.each([
		["a short TMPDIR (the file under it)", 0],
		["a long TMPDIR (the file in /tmp/chord-lock-<uid>)", 60],
	])(
		"a taker waits while a process of the previous release holds the lock's socket file, with %s",
		async (_what, padding) => {
			const name = lockName("legacy");
			const temporary = await mkdtemp("/tmp/chord-legacy-");
			const deep = join(temporary, "d".repeat(padding));
			await mkdir(deep, { recursive: true });
			const before = process.env.TMPDIR;
			process.env.TMPDIR = `${deep}/`;
			try {
				const legacy = await spawned(LEGACY_HOLDER, [name], { ...process.env });
				const file = await legacy.next();
				files.add(file);
				expect(file.startsWith(deep)).toBe(padding === 0);
				let taken = false;
				const taking = processLock(name, context).then((lock) => {
					taken = true;
					return lock;
				});
				// The taker holds its flock while it waits: the check comes after the take.
				expect(await held(name)).toBe(true);
				await new Promise((resolve) => setTimeout(resolve, 200));
				expect(taken).toBe(false);
				const ended = Date.now();
				await killed(legacy.process, "SIGTERM");
				await (await taking).release();
				expect(Date.now() - ended).toBeLessThan(200);
				expect(existsSync(file)).toBe(true);
			} finally {
				if (before === undefined) delete process.env.TMPDIR;
				else process.env.TMPDIR = before;
				await rm(temporary, { recursive: true, force: true });
			}
		},
	);

	it("a taker aborted while it waits for a holder of the previous release gives its flock back", async () => {
		const name = lockName("legacy-abort");
		const legacy = await spawned(LEGACY_HOLDER, [name]);
		files.add(await legacy.next());
		await expect(processLock(name, withAbortSignal(AbortSignal.timeout(300), context))).rejects.toHaveProperty(
			"name",
			"TimeoutError",
		);
		expect(await processLockState(name, context)).toBe("free");
	});

	// The second takes the old file while the first still has the taker's connection: the taker must look again.
	it("a taker waits for each holder of the previous release that has the old socket file in turn", async () => {
		const name = lockName("legacy-turn");
		const first = await spawned(LEGACY_HOLDER, [name]);
		files.add(await first.next());
		let second: Spawned | undefined;
		let taken = false;
		const taking = processLock(name, context).then((lock) => {
			taken = true;
			return lock;
		});
		try {
			// Accepted, the taker's connection outlives the first's close; a queued one would be reset by it.
			expect(await first.next()).toBe("accepted");
			first.process.kill("SIGUSR2");
			expect(await first.next()).toBe("closed");
			second = await spawned(LEGACY_HOLDER, [name]);
			await second.next();
			await killed(first.process, "SIGTERM");
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(taken).toBe(false);
			await killed(second.process, "SIGTERM");
			await (await taking).release();
		} finally {
			first.process.kill("SIGKILL");
			second?.process.kill("SIGKILL");
			await taking.then(
				(lock) => lock.release(),
				() => {},
			);
		}
	});
});

describe.skipIf(LOCKS)("a platform without process locks (AIX, SunOS)", () => {
	it("refuses a take, naming the platform", async () => {
		await expect(processLock("chord-test-lock-none", context)).rejects.toThrow(
			`processLock: no process locks on ${process.platform}`,
		);
	});
});

let made = 0;

/** A lock name unique to this run and case (lock names are per user), released after the case. */
function lockName(what: string): string {
	const name = `chord-test-lock-${what}-${process.pid}-${++made}`;
	names.add(name);
	return name;
}

function holder(name: string, then: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<Spawned> {
	return spawned(HOLDER, [name, ...then], env);
}

/** The fixture `file` run with `args`, once its first line said `held`. */
async function spawned(file: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<Spawned> {
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", file, ...args], {
		env,
		stdio: ["ignore", "pipe", "inherit"],
	});
	if (child.pid === undefined) throw new Error(`${file}: did not start`);
	started.add(child.pid);
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	const next = async (): Promise<string> => {
		const line = await lines.next();
		if (line.done === true) throw new Error(`${file}: exited`);
		return line.value;
	};
	expect(await next()).toBe("held");
	return { process: child, next };
}

/** Whether the state of `name` reads `held` within 2 s. */
async function held(name: string): Promise<boolean> {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		if ((await processLockState(name, context)) === "held") return true;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return false;
}

/** Kills `child` with `signal` (SIGKILL: no exit hooks run) and resolves once it exited. */
async function killed(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill(signal);
	await exited;
}

/**
 * Expects `name` still held after 400 refused connects and 200 probes, and a take waiting 300 ms that pauses between
 * its tries (1 ms doubling to 100 ms: at most about a dozen connects, where spinning would make thousands).
 */
async function expectKept(name: string): Promise<void> {
	const socket = lockSocket(name);
	const queued = [];
	let refused = 0;
	for (let i = 0; i < 2000 && refused < 400; i++) {
		const connection = connect(socket);
		queued.push(connection);
		const outcome = await new Promise<string>((resolve) => {
			connection.once("connect", () => resolve("queued"));
			connection.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
		});
		if (outcome === "ECONNREFUSED" || outcome === "EAGAIN") refused++;
	}
	expect(refused).toBe(400);
	for (const connection of queued) connection.destroy();
	for (let i = 0; i < 200; i++) expect(await processLockState(name, context)).toBe("held");
	const activity = lockActivity();
	try {
		await expect(processLock(name, withAbortSignal(AbortSignal.timeout(300), context))).rejects.toHaveProperty(
			"name",
			"TimeoutError",
		);
		expect(activity.connects()).toBeLessThan(20);
	} finally {
		activity.stop();
	}
}

/** Counts the client connects and timers `lock.ts` makes from now on, told apart by the stack that made them. */
function lockActivity(): { connects(): number; timers(): number; stop(): void } {
	let connects = 0;
	let timers = 0;
	const created = (): void => {
		if (madeByLock()) connects++;
	};
	const hook = createHook({
		init: (_id, type) => {
			if (type === "Timeout" && madeByLock()) timers++;
		},
	});
	subscribe("net.client.socket", created);
	hook.enable();
	return {
		connects: () => connects,
		timers: () => timers,
		stop: () => {
			hook.disable();
			unsubscribe("net.client.socket", created);
		},
	};
}

function madeByLock(): boolean {
	const limit = Error.stackTraceLimit;
	Error.stackTraceLimit = 50;
	const stack = (new Error().stack ?? "").replaceAll("\\", "/");
	Error.stackTraceLimit = limit;
	return stack.includes(LOCK_SOURCE);
}

/** The socket a holder of `name` listens on, on macOS, the BSDs, Linux and Android. */
function lockSocket(name: string): string {
	return FLOCK ? join(lockDirectory(name), "s.sock") : `\0chord-lock-${keyOf(name)}`;
}

function lockDirectory(name: string): string {
	const base =
		process.platform === "darwin" ? `${userTemp()}chord-lock` : `/tmp/chord-lock-${process.getuid?.() ?? 0}`;
	return join(base, keyOf(name));
}

function keyOf(name: string): string {
	return createHash("sha256").update(name).digest("hex").slice(0, 32);
}

/** macOS's user temporary directory, with its trailing slash. */
function userTemp(): string {
	return execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
}

function kill(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// Gone.
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
