// A process holding a process lock, for the lock tests: `lock-holder.ts <name> <then> [arguments]` prints `held` once
// it holds the lock, then `stay`s until killed, or: `children` (forks and spawns a child holding nothing, prints their
// pids), `block <ms>` (blocks its event loop), `cycle <takes> <marker> <socket>` (releases and takes again, prints
// `cycled <failures>`), `exit` (exits without a release).

import { fork, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, unlinkSync } from "node:fs";
import { BACKGROUND_CONTEXT as context } from "../../../../src/context/index.ts";
import { type ProcessLock, processLock } from "../../../../src/node/workers/lock.ts";

const [name = "", then = "stay", ...rest] = process.argv.slice(2);
// Without a name: a forked child, holding nothing.
if (name !== "") await hold(name, then, rest);
setInterval(() => {}, 1000);

async function hold(name: string, then: string, rest: readonly string[]): Promise<void> {
	const lock = await processLock(name, context);
	console.log("held");
	if (then === "children") {
		// On Windows libuv's job object ends a child with its parent unless it is detached.
		const detached = process.platform === "win32";
		const forked = fork(import.meta.filename, [], { stdio: "ignore", detached });
		const spawned = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit", detached });
		console.log(`children ${forked.pid} ${spawned.pid}`);
	} else if (then === "block") {
		const end = Date.now() + Number(rest[0]);
		while (Date.now() < end) {}
	} else if (then === "cycle") {
		console.log(`cycled ${await cycle(name, lock, Number(rest[0]), rest[1] ?? "", rest[2] ?? "")}`);
	} else if (then === "exit") {
		process.exit(0);
	}
}

/**
 * Releases and takes `name` again `takes` times; counts the takes during which `marker` existed already (two holders)
 * or the lock's `socket` file (when given) was missing.
 */
async function cycle(name: string, held: ProcessLock, takes: number, marker: string, socket: string): Promise<number> {
	let lock = held;
	let failures = 0;
	for (let i = 0; i < takes; i++) {
		await lock.release();
		lock = await processLock(name, context);
		if (socket !== "" && !existsSync(socket)) failures++;
		try {
			closeSync(openSync(marker, "wx"));
		} catch {
			failures++;
			continue;
		}
		// Gives the other racers' takes a chance while this one holds.
		await new Promise((resolve) => setImmediate(resolve));
		unlinkSync(marker);
	}
	await lock.release();
	return failures;
}
