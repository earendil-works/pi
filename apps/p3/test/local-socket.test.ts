// The local socket (`src/local-socket.ts`): the lock and channel of a server, a supervisor and a session's worker. One
// holder at a time, also when several take a killed holder's file at once; a release removes only its own file; a
// waiter (a session's next worker) takes it once the holder released it or died; `ask` gets the holder's answer, and
// nothing when nobody holds it; neither end fails on what is no JSON; a path too long for a socket is refused.

import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { lstat, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	ask,
	askServer,
	askSupervisor,
	checkSocketPaths,
	MAX_SOCKET_PATH_BYTES,
	takeSocket,
	waitForSocket,
} from "../src/local-socket.ts";

let dir: string;

/** The holder processes a case started: killed after it, whatever it left. */
const holders: ChildProcess[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "p3-socket-"));
});

afterEach(async () => {
	for (const holder of holders.splice(0)) holder.kill("SIGKILL");
	await rm(dir, { recursive: true, force: true });
});

describe("a local socket", () => {
	it("has one holder at a time, answers its requests, and is free once released", async () => {
		const path = join(dir, "server.sock");
		const first = await takeSocket(path, async (request) => ({ echo: request }));
		assert.equal(first.kind, "taken");
		if (first.kind !== "taken") return;
		assert.deepEqual(await takeSocket(path), { kind: "held" });
		assert.deepEqual(await ask(path, { kind: "status" }), { echo: { kind: "status" } });
		await first.socket.release();
		assert.equal(await ask(path, { kind: "status" }), undefined);
		const second = await takeSocket(path);
		assert.equal(second.kind, "taken");
		if (second.kind === "taken") await second.socket.release();
		// No temporary name is left beside it.
		assert.deepEqual(await readdir(dir), []);
	});

	it("is taken over from a holder killed without its exit hooks: its file answers nobody", async () => {
		const path = join(dir, "lock");
		const holder = await holderProcess(path);
		holder.kill("SIGKILL");
		await new Promise((resolve) => holder.once("exit", resolve));
		assert.equal(await ask(path, {}), undefined);
		const taken = await takeSocket(path);
		assert.equal(taken.kind, "taken");
		if (taken.kind === "taken") await taken.socket.release();
	});

	// Sol, Astra and Opus, review round 2 (D8): two takers both found the killed holder's file dead, one replaced it,
	// and the other removed the new holder's file and listened too: two servers on one store.
	it("has exactly one holder when several take a killed holder's file at once, round after round", async () => {
		const path = join(dir, "server.sock");
		for (let round = 0; round < 30; round++) {
			await staleAt(path);
			const taken = await Promise.all([1, 2, 3, 4].map((n) => takeSocket(path, async () => n)));
			const winners = taken.filter((one) => one.kind === "taken");
			assert.equal(winners.length, 1, `round ${round}`);
			// The one that answers is the winner, and nobody else's file replaced its own.
			assert.equal(typeof (await ask(path, {})), "number");
			for (const winner of winners) await winner.socket.release();
		}
	});

	it("removes only its own file at its release: a file another holder placed there stays", async () => {
		const path = join(dir, "server.sock");
		const first = await takeSocket(path, async () => "first");
		assert.equal(first.kind, "taken");
		// Someone removed the file by hand, and a second holder took the path.
		await rm(path);
		const second = await takeSocket(path, async () => "second");
		assert.equal(second.kind, "taken");
		if (first.kind === "taken") await first.socket.release();
		assert.equal(await ask(path, {}), "second");
		if (second.kind === "taken") await second.socket.release();
		await assert.rejects(lstat(path), { code: "ENOENT" });
	});

	it("refuses a path that holds a file that is no socket, and leaves the file", async () => {
		const path = join(dir, "server.sock");
		await writeFile(path, "mine");
		await assert.rejects(takeSocket(path), /is not a socket/);
		assert.deepEqual(await readdir(dir), ["server.sock"]);
	});

	it("makes a waiter wait while the holder lives, and take it once the holder died", async () => {
		const path = join(dir, "lock");
		const holder = await holderProcess(path);
		let took = false;
		const waiting = waitForSocket(path, context).then((socket) => {
			took = true;
			return socket;
		});
		// A wait that must not end: no event to wait for, so a fixed time.
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(took, false, "the holder still lives");
		holder.kill("SIGKILL");
		const socket = await waiting;
		await socket.release();
	});
});

describe("asking a holder", () => {
	// Opus, review round 2 (N3): a command's answer that is no JSON threw past the socket and crashed the server.
	it("gets a `failed` answer when the holder's answer is no JSON, and the holder goes on", async () => {
		const path = join(dir, "server.sock");
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		const answers = [{ big: 1n }, cyclic, "fine"];
		const taken = await takeSocket(path, async () => answers.shift());
		for (const _ of [1, 2]) {
			const answer = (await ask(path, {})) as { readonly kind: string; readonly error: string };
			assert.equal(answer.kind, "failed");
			assert.match(answer.error, /no JSON/);
		}
		assert.equal(await ask(path, {}), "fine");
		if (taken.kind === "taken") await taken.socket.release();
	});

	// Opus, review round 2 (N3): `JSON.parse` of an answer threw in the socket's event handler, uncaught.
	it("rejects an answer that is no JSON, instead of throwing in an event handler", async () => {
		const path = join(dir, "server.sock");
		const raw = await rawHolder(path, "not json\n");
		await assert.rejects(ask(path, {}), /answered no JSON/);
		raw.close();
	});

	// Astra, review round 2 (S1): `--wait 0` passed 0 to `setTimeout`, which disables it: a hung holder held the
	// command for ever.
	it("tells a holder that does not answer from no holder, also with a timeout of 0 ms", async () => {
		const path = join(dir, "server.sock");
		const silent = await takeSocket(path);
		for (const ms of [0, 50]) {
			assert.deepEqual(await askServer(dir, { kind: "status" }, ms), { kind: "silent" });
		}
		await assert.rejects(ask(path, {}, 50), /did not answer within 50 ms/);
		if (silent.kind === "taken") await silent.socket.release();
		assert.deepEqual(await askServer(dir, { kind: "status" }, 50), { kind: "none" });
	});

	// Astra, review round 2 (S6): the command signalled whatever pid an answer named.
	it("refuses an answer of a shape p3 does not know, and pids that name no single process", async () => {
		const shapes = [
			{ kind: "running", pid: 1, port: 1, version: "v", startedAt: 0 },
			{ kind: "running", pid: 0, port: 1, version: "v", startedAt: 0 },
			{ kind: "starting", pid: -1 },
			{ kind: "starting", pid: "12" },
			{ kind: "running", pid: 1234, port: 70_000, version: "v", startedAt: 0 },
			{ kind: "stopping" },
			"running",
			null,
		];
		for (const shape of shapes) {
			const taken = await takeSocket(join(dir, "server.sock"), async () => shape);
			await assert.rejects(askServer(dir, { kind: "status" }, 1000), /answered/, JSON.stringify(shape));
			if (taken.kind === "taken") await taken.socket.release();
		}
		const supervisor = [
			{ kind: "supervising", pid: 1234, server: 1 },
			{ kind: "running", pid: 1234 },
		];
		for (const shape of supervisor) {
			const taken = await takeSocket(join(dir, "supervisor.sock"), async () => shape);
			await assert.rejects(askSupervisor(dir, { kind: "status" }, 1000), /answered/, JSON.stringify(shape));
			if (taken.kind === "taken") await taken.socket.release();
		}
		const running = { kind: "running", pid: 1234, port: 8789, version: "v", startedAt: 0 };
		const taken = await takeSocket(join(dir, "server.sock"), async () => running);
		assert.deepEqual(await askServer(dir, { kind: "status" }, 1000), { kind: "answered", answer: running });
		if (taken.kind === "taken") await taken.socket.release();
	});
});

describe("a data directory's socket paths", () => {
	// Sol, Astra, Opus and Fable, review round 2 (D12): a long data directory failed with `listen EINVAL`, or started a
	// server whose every worker failed (a session's lock is the longest path).
	it("are refused, naming the limit, when a session's lock would not fit; a directory one byte shorter fits", () => {
		// `<dataDir>/locks/<16 hex>`: 23 bytes after the directory.
		const fits = `/${"d".repeat(MAX_SOCKET_PATH_BYTES - 23 - 1)}`;
		checkSocketPaths(fits);
		assert.throws(() => checkSocketPaths(`${fits}x`), new RegExp(`longer than the ${MAX_SOCKET_PATH_BYTES}`));
		// Bytes, not characters.
		assert.throws(() => checkSocketPaths(`${fits.slice(0, -1)}ä`), /bytes, longer/);
	});

	it("are refused at a take too, before anything listens", async () => {
		const path = join(dir, "x".repeat(MAX_SOCKET_PATH_BYTES));
		await assert.rejects(takeSocket(path), /use a data directory with a shorter path/);
	});
});

/** Leaves a socket file at `path` that nobody listens on, as a holder killed without its exit hooks does. */
async function staleAt(path: string): Promise<void> {
	const temporary = join(dir, "t");
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(temporary, resolve));
	// The bound file moves; libuv removes only the name it listened on (gone) when the server closes.
	await rename(temporary, path);
	await new Promise((resolve) => server.close(resolve));
	assert.ok((await lstat(path)).isSocket());
}

/** A server at `path` that writes `text` to every connection. */
async function rawHolder(path: string, text: string): Promise<Server> {
	const server = createServer((socket) => socket.end(text));
	await new Promise<void>((resolve) => server.listen(path, resolve));
	return server;
}

/** A process holding the socket at `path` (it answers nothing), once it holds it. */
async function holderProcess(path: string) {
	const script = join(dir, "holder.mts");
	const module = new URL("../src/local-socket.ts", import.meta.url).href;
	await writeFile(
		script,
		[
			`import { takeSocket } from ${JSON.stringify(module)};`,
			`const taken = await takeSocket(${JSON.stringify(path)});`,
			`process.send?.(taken.kind);`,
			"setInterval(() => {}, 1000);",
		].join("\n"),
	);
	const child = fork(script, [], { execArgv: ["--conditions=source", "--disable-warning=ExperimentalWarning"] });
	holders.push(child);
	const said = await new Promise((resolve) => child.once("message", resolve));
	assert.equal(said, "taken");
	return child;
}
