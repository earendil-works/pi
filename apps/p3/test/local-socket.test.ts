// The data directory's sockets (`src/local-socket.ts`): one holder at a time, also when several take a killed holder's
// file at once; a release removes only its own file; a take that waits for its guard ends with its context and leaves
// nothing behind; `exchange` gets the holder's answer, nothing when nobody holds it, and `silent` once its deadline
// passed; neither end fails on what is no JSON or on a character split between reads; a path too long for a socket is
// refused.

import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import { processLock } from "@earendil-works/chord/workers/child";
import {
	askServer,
	askSupervisor,
	checkSocketPaths,
	exchange,
	MAX_SOCKET_PATH_BYTES,
	type Taken,
	takeSocket,
} from "../src/local-socket.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "p3-socket-"));
});

/** What a case opened, closed after it also when it failed: a holder left open would keep the runner from ending. */
const opened: (() => unknown)[] = [];

afterEach(async () => {
	for (const close of opened.splice(0)) await close();
	await rm(dir, { recursive: true, force: true });
});

/** The answer of the holder at `path` (`undefined`: none); a holder that did not answer in `ms` fails the case. */
async function answerOf(path: string, request: unknown, ms?: number): Promise<unknown> {
	const reply = await exchange(path, request, ms);
	assert.notEqual(reply.kind, "silent", `${path} did not answer`);
	return reply.kind === "answered" ? reply.answer : undefined;
}

describe("a local socket", () => {
	it("has one holder at a time, answers its requests, and is free once released", async () => {
		const path = join(dir, "server.sock");
		const first = releasedAfter(await takeSocket(path, context, async (request) => ({ echo: request })));
		assert.equal(first.kind, "taken");
		if (first.kind !== "taken") return;
		assert.deepEqual(await takeSocket(path, context), { kind: "held" });
		assert.deepEqual(await answerOf(path, { kind: "status" }), { echo: { kind: "status" } });
		await first.socket.release();
		assert.equal(await answerOf(path, { kind: "status" }), undefined);
		const second = releasedAfter(await takeSocket(path, context));
		assert.equal(second.kind, "taken");
		if (second.kind === "taken") await second.socket.release();
		// No temporary name is left beside it.
		assert.deepEqual(await readdir(dir), []);
	});

	// Sol, Astra and Opus, review round 2 (D8): two takers both found the killed holder's file dead, one replaced it,
	// and the other removed the new holder's file and listened too: two servers on one store.
	it("has exactly one holder when several take a killed holder's file at once, round after round", async (t) => {
		const path = join(dir, "server.sock");
		for (let round = 0; round < 30; round++) {
			await staleAt(path);
			const taken = await Promise.all([1, 2, 3, 4].map((n) => takeSocket(path, context, async () => n)));
			const winners = taken.flatMap((one) => (one.kind === "taken" ? [one.socket] : []));
			// Released also when an assertion below fails.
			t.after(() => Promise.all(winners.map((winner) => winner.release())));
			assert.equal(winners.length, 1, `round ${round}`);
			// The one that answers is the winner, and nobody else's file replaced its own.
			assert.equal(typeof (await answerOf(path, {})), "number");
			for (const winner of winners) await winner.release();
		}
	});

	it("removes only its own file at its release: a file another holder placed there stays", async () => {
		const path = join(dir, "server.sock");
		const first = releasedAfter(await takeSocket(path, context, async () => "first"));
		assert.equal(first.kind, "taken");
		// Someone removed the file by hand, and a second holder took the path.
		await rm(path);
		const second = releasedAfter(await takeSocket(path, context, async () => "second"));
		assert.equal(second.kind, "taken");
		if (first.kind === "taken") await first.socket.release();
		assert.equal(await answerOf(path, {}), "second");
		if (second.kind === "taken") await second.socket.release();
		await assert.rejects(lstat(path), { code: "ENOENT" });
	});

	it("refuses a path that holds a file that is no socket, and leaves the file", async () => {
		const path = join(dir, "server.sock");
		await writeFile(path, "mine");
		await assert.rejects(takeSocket(path, context), /is not a socket/);
		assert.deepEqual(await readdir(dir), ["server.sock"]);
	});

	// Astra, review round 3 (S3): the take waited for its guard without its context, and a guard that failed left the
	// temporary socket listening in the private directory.
	it("ends a take waiting for its guard when its context aborts, leaving nothing behind", async () => {
		const path = join(dir, "server.sock");
		const guard = await processLock(`p3-socket:${path}`, context);
		try {
			const { context: cancellable, cancel } = withCancel(context);
			const taking = takeSocket(path, cancellable);
			// The take listens on its temporary name, then waits for the guard.
			while ((await readdir(dir)).length === 0) await new Promise((resolve) => setImmediate(resolve));
			cancel(new Error("gave up"));
			await assert.rejects(taking, /gave up/);
			assert.deepEqual(await readdir(dir), []);
		} finally {
			await guard.release();
		}
		// A take cancelled before it began takes nothing either, also on a free path.
		const { context: cancelled, cancel } = withCancel(context);
		cancel(new Error("never"));
		await assert.rejects(takeSocket(path, cancelled), /never/);
		assert.deepEqual(await readdir(dir), []);
	});
});

describe("asking a holder", () => {
	// Opus, review round 2 (N3): a command's answer that is no JSON threw past the socket and crashed the server.
	it("gets a `failed` answer when the holder's answer is no JSON, and the holder goes on", async () => {
		const path = join(dir, "server.sock");
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		const answers = [{ big: 1n }, cyclic, "fine"];
		const taken = releasedAfter(await takeSocket(path, context, async () => answers.shift()));
		for (const _ of [1, 2]) {
			const answer = (await answerOf(path, {})) as { readonly kind: string; readonly error: string };
			assert.equal(answer.kind, "failed");
			assert.match(answer.error, /no JSON/);
		}
		assert.equal(await answerOf(path, {}), "fine");
		if (taken.kind === "taken") await taken.socket.release();
	});

	// Opus, review round 2 (N3): `JSON.parse` of an answer threw in the socket's event handler, uncaught.
	it("rejects an answer that is no JSON, instead of throwing in an event handler", async () => {
		const path = join(dir, "server.sock");
		await rawHolder(path, (socket) => socket.end("not json\n"));
		await assert.rejects(exchange(path, {}), /answered no JSON/);
	});

	// Astra, review round 3 (nit): each chunk was decoded on its own, so a character split between two reads broke.
	it("keeps a character whole that is split between two reads, both ways", async () => {
		const path = join(dir, "server.sock");
		const line = Buffer.from(`${JSON.stringify("Grüße")}\n`);
		// "ü" is two bytes: the first chunk ends inside it.
		const split = line.indexOf(0xc3) + 1;
		await rawHolder(path, (socket) => {
			socket.write(line.subarray(0, split));
			setTimeout(() => socket.end(line.subarray(split)), 20);
		});
		assert.equal(await answerOf(path, {}), "Grüße");
		const echoing = join(dir, "echo.sock");
		const taken = releasedAfter(await takeSocket(echoing, context, async (request) => request));
		const answer = await new Promise<string>((resolve) => {
			const socket = connect(echoing);
			let text = "";
			socket.on("data", (chunk) => {
				text += chunk.toString();
			});
			socket.once("close", () => resolve(text));
			socket.write(line.subarray(0, split));
			setTimeout(() => socket.write(line.subarray(split)), 20);
		});
		assert.equal(JSON.parse(answer), "Grüße");
		if (taken.kind === "taken") await taken.socket.release();
	});

	// Astra, review round 2 (S1): `--wait 0` passed 0 to `setTimeout`, which disables it: a hung holder held the
	// command for ever.
	it("tells a holder that does not answer from no holder, also with a timeout of 0 ms", async () => {
		const path = join(dir, "server.sock");
		const silent = releasedAfter(await takeSocket(path, context));
		for (const ms of [0, 50]) {
			assert.deepEqual(await askServer(dir, { kind: "status" }, ms), { kind: "silent" });
		}
		if (silent.kind === "taken") await silent.socket.release();
		assert.deepEqual(await askServer(dir, { kind: "status" }, 50), { kind: "none" });
	});

	// Astra, review round 3 (nit): the socket's own timeout restarted with each chunk, so a holder that kept sending
	// without ending its line held the ask for ever.
	it("gives up at its deadline also on a holder that keeps sending", async () => {
		const path = join(dir, "server.sock");
		await rawHolder(path, (socket) => {
			socket.on("error", () => {});
			const timer = setInterval(() => socket.write(" "), 10);
			socket.once("close", () => clearInterval(timer));
		});
		const reply = await Promise.race([
			exchange(path, {}, 100),
			new Promise((resolve) => setTimeout(resolve, 2000, "still asking")),
		]);
		assert.deepEqual(reply, { kind: "silent" });
	});

	// Astra, review round 2 (S6): the command signalled whatever pid an answer named.
	it("refuses an answer of a shape p3 does not know, and pids that name no single process", async () => {
		const shapes = [
			{ kind: "running", pid: 1, workers: [], port: 1, version: "v", startedAt: 0 },
			{ kind: "running", pid: 0, workers: [], port: 1, version: "v", startedAt: 0 },
			{ kind: "running", pid: 1234, workers: [-1], port: 1, version: "v", startedAt: 0 },
			{ kind: "running", pid: 1234, port: 1, version: "v", startedAt: 0 },
			{ kind: "starting", pid: -1, workers: [] },
			{ kind: "starting", pid: "12", workers: [] },
			{ kind: "starting", pid: 1234, workers: [1] },
			{ kind: "running", pid: 1234, workers: [], port: 70_000, version: "v", startedAt: 0 },
			{ kind: "stopping" },
			"running",
			null,
		];
		for (const shape of shapes) {
			const taken = releasedAfter(await takeSocket(join(dir, "server.sock"), context, async () => shape));
			await assert.rejects(askServer(dir, { kind: "status" }, 1000), /answered/, JSON.stringify(shape));
			if (taken.kind === "taken") await taken.socket.release();
		}
		const supervisor = [
			{ kind: "supervising", pid: 1234, server: 1 },
			{ kind: "running", pid: 1234 },
		];
		for (const shape of supervisor) {
			const taken = releasedAfter(await takeSocket(join(dir, "supervisor.sock"), context, async () => shape));
			await assert.rejects(askSupervisor(dir, { kind: "status" }, 1000), /answered/, JSON.stringify(shape));
			if (taken.kind === "taken") await taken.socket.release();
		}
		const running = { kind: "running", pid: 1234, workers: [4321], port: 8789, version: "v", startedAt: 0 };
		const taken = releasedAfter(await takeSocket(join(dir, "server.sock"), context, async () => running));
		assert.deepEqual(await askServer(dir, { kind: "status" }, 1000), { kind: "answered", answer: running });
		if (taken.kind === "taken") await taken.socket.release();
	});
});

describe("a data directory's socket paths", () => {
	// Sol, Astra, Opus and Fable, review round 2 (D12): a long data directory failed with `listen EINVAL`, or started a
	// server whose every worker failed.
	it("are refused, naming the limit, when the supervisor's socket would not fit; a directory one byte shorter fits", () => {
		// `<dataDir>/supervisor.sock`: 16 bytes after the directory, the longest of a Pi's socket paths.
		const fits = `/${"d".repeat(MAX_SOCKET_PATH_BYTES - 16 - 1)}`;
		checkSocketPaths(fits);
		assert.throws(() => checkSocketPaths(`${fits}x`), new RegExp(`longer than the ${MAX_SOCKET_PATH_BYTES}`));
		// Bytes, not characters.
		assert.throws(() => checkSocketPaths(`${fits.slice(0, -1)}ä`), /bytes, longer/);
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

/** `taken`, released after the case. */
function releasedAfter(taken: Taken): Taken {
	if (taken.kind === "taken") opened.push(() => taken.socket.release());
	return taken;
}

/** A server at `path` that answers each connection with `answer`, closed after the case with its connections. */
async function rawHolder(path: string, answer: (socket: Socket) => void): Promise<Server> {
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		answer(socket);
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	opened.push(() => {
		for (const socket of sockets) socket.destroy();
		return new Promise((resolve) => server.close(resolve));
	});
	return server;
}
