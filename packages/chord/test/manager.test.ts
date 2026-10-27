import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { createHost, ipcLink, isChordError } from "../src/index.ts";
import { type ControlMessage, createHostManager, type Driver, forkDriver, processLock } from "../src/manager.ts";
import { Echo } from "./fixtures/echo.ts";

const entry = fileURLToPath(new URL("./fixtures/worker.ts", import.meta.url));
const scratch = (name: string) => join(tmpdir(), `chord2-${process.pid}-${name}`);

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const driver = (env: Record<string, string> = {}, lock?: string): Driver =>
	forkDriver({ entry, env: { HOST_NAME: "w1", ...env }, init: { greeting: "hi" }, lock });

describe("processLock", () => {
	// A socket path over 104 bytes failed with EINVAL on macOS when TMPDIR was deep (./test.sh below macOS's TMPDIR).
	it("admits one holder when the temporary directory is too deep for a socket path", async () => {
		const deep = join(scratch("deep"), "a".repeat(60), "b".repeat(60));
		mkdirSync(deep, { recursive: true });
		const previous = process.env.TMPDIR;
		process.env.TMPDIR = deep;
		try {
			const name = `deep-${process.pid}`;
			const release = await processLock(name);
			await assert.rejects(processLock(name), (error) => isChordError(error) && error.reason === "locked");
			await release();
			await (await processLock(name))();
		} finally {
			if (previous === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previous;
			rmSync(scratch("deep"), { recursive: true, force: true });
		}
	});
});

describe("host manager (real child processes)", () => {
	// A child host that forks its own children used to pass its CHORD2_LOCK on, so they failed with "locked".
	it("a child without a lock does not inherit the parent's lock", async () => {
		const name = `chord2-test-${process.pid}-inherited`;
		const release = await processLock(name);
		const previous = process.env.CHORD2_LOCK;
		process.env.CHORD2_LOCK = name;
		const manager = createHostManager({ driver: driver() });
		try {
			await manager.start();
			assert.equal(manager.status, "running");
		} finally {
			if (previous === undefined) delete process.env.CHORD2_LOCK;
			else process.env.CHORD2_LOCK = previous;
			await manager.stop();
			await release();
		}
	});

	it("starts a child host, links it, stops it gracefully", async () => {
		const manager = createHostManager({ driver: driver() });
		const instance = await manager.start();
		assert.equal(manager.status, "running");
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		server.accept(instance.link, { principal: { worker: "w1" }, kind: "host", name: "w1" });
		const echo = server.hold(Echo, {});
		assert.equal(await echo.echo("x"), `hi x from ${instance.pid}`);
		assert.equal(await manager.start(), instance);
		await manager.stop();
		assert.equal(manager.status, "stopped");
		assert.deepEqual(await instance.exited, { code: 0, signal: null });
		await server.close();
	});

	it("a child-owned kernel lock admits one live process; replace waits for the exit before the next start", async () => {
		const lock = `chord2-test-${process.pid}-lock`;
		const pids: number[] = [];
		const base = driver({}, lock);
		const watched: Driver = {
			spawn() {
				// Exit before replace: the previous child is gone when the next one spawns.
				for (const pid of pids) assert.ok(!alive(pid), `pid ${pid} still alive`);
				const instance = base.spawn();
				pids.push(instance.pid);
				return instance;
			},
		};
		const first = createHostManager({ driver: watched });
		const second = createHostManager({ driver: driver({}, lock) });
		const a = await first.start();
		// Both managers race for the same lock; only the kernel decides, so the second child cannot start.
		await assert.rejects(second.start(), (error) => isChordError(error, "unavailable") && error.reason === "locked");
		const b = await first.replace();
		assert.notEqual(a.pid, b.pid);
		await first.stop();
		await second.start();
		await second.stop();
	});

	it("a graceful exit still takes the child's descendants with it", async () => {
		const file = scratch("grandchild-graceful");
		rmSync(file, { force: true });
		const manager = createHostManager({ driver: driver({ GRANDCHILD_FILE: file }) });
		await manager.start();
		const grandchild = Number(readFileSync(file, "utf8"));
		assert.ok(alive(grandchild));
		await manager.stop();
		for (let i = 0; i < 50 && alive(grandchild); i++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(!alive(grandchild));
		rmSync(file, { force: true });
	});

	it("idleFor counts from the busy → idle transition", async () => {
		const listeners = new Set<(message: ControlMessage) => void>();
		const fake: Driver = {
			spawn: () => ({
				pid: 0,
				link: ipcLink({ connected: false, send: () => false, on: () => undefined, off: () => undefined }),
				exited: new Promise(() => {}),
				send: () => {},
				killTree: () => {},
				onControl: (listener) => listeners.add(listener),
			}),
		};
		const emit = (message: ControlMessage) => {
			for (const listener of listeners) listener(message);
		};
		const manager = createHostManager({ driver: fake });
		const started = manager.start();
		for (let i = 0; i < 20 && listeners.size === 0; i++) await new Promise((resolve) => setImmediate(resolve));
		emit({ type: "ready" });
		await started;
		emit({ type: "status", activeCalls: 1 });
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.equal(manager.liveness.idleFor, 0);
		emit({ type: "status", activeCalls: 0 });
		assert.ok(manager.liveness.idleFor < 60, `idleFor ${manager.liveness.idleFor}`);
	});

	it("kills the process tree when a child ignores shutdown past the grace period", async () => {
		const file = scratch("grandchild");
		rmSync(file, { force: true });
		const manager = createHostManager({
			driver: driver({ FIXTURE_MODE: "ignore-shutdown", GRANDCHILD_FILE: file }),
			grace: 300,
		});
		const instance = await manager.start();
		const grandchild = Number(readFileSync(file, "utf8"));
		assert.ok(alive(grandchild));
		await manager.stop();
		assert.equal((await instance.exited).signal, "SIGKILL");
		for (let i = 0; i < 50 && alive(grandchild); i++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(!alive(grandchild));
		rmSync(file, { force: true });
	});

	it("reports a fatal child as a failed start", async () => {
		const manager = createHostManager({ driver: driver({ FIXTURE_MODE: "fatal" }) });
		await assert.rejects(manager.start(), /fixture refuses to start/);
		assert.equal(manager.status, "stopped");
	});

	it("stops an idle child when keepAlive says so", async () => {
		const exits: unknown[] = [];
		const manager = createHostManager({
			driver: driver(),
			keepAlive: (liveness) => !liveness.booting && liveness.idleFor < 150,
			checkInterval: 50,
			onExit: (exit) => exits.push(exit),
		});
		await manager.start();
		for (let i = 0; i < 100 && manager.status !== "stopped"; i++)
			await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(manager.status, "stopped");
		assert.equal(exits.length, 1);
	});
});
