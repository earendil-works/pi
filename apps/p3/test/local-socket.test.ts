// The local socket (`src/local-socket.ts`): the lock and channel of a server, a supervisor and a session's worker. One
// holder at a time; a socket file a killed holder left is cleared by the next taker; a waiter (a session's next worker)
// takes it once the holder released it or died; `ask` gets the holder's answer, and nothing when nobody holds it.

import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ask, takeSocket, waitForSocket } from "../src/local-socket.ts";

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
