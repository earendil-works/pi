// Process locks (decision "Process locks are kernel locks on macOS and the BSDs"): one live holder per name across
// processes, as the workers component keeps one live worker per address and an app one server per data directory. The
// holder is whoever owns a kernel object that ends with its process (an abstract socket on Linux and Android, a named
// pipe on Windows, an exclusive flock on a directory in the user temporary directory macOS fixes, or in
// `/tmp/chord-lock-<uid>` on the BSDs), so a holder killed by a signal leaves nothing anyone has to clear. Here: the
// state read without taking the lock; a second process that holds it while this one waits, without polling; that
// process killed with SIGKILL, and this one taking the lock at once.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/80-process-locks.ts
import { fork } from "node:child_process";
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { processLock, processLockState } from "../../src/node/workers/child.ts";

const context = BACKGROUND_CONTEXT;
const name = `example-process-locks-${process.argv[3] ?? process.pid}`;

if (process.argv[2] === "holder") {
	// The second process: takes the lock, says so, and keeps it until it is killed.
	await processLock(name, context);
	process.send?.("held");
	setInterval(() => {}, 1000);
} else {
	// 1. The state: read without taking the lock (on macOS and the BSDs a shared flock taken and dropped at once).
	console.log(`1. before anyone took it: ${await processLockState(name, context)}`);

	// 2. Another process takes it; the state says so, and a take here waits.
	const holder = fork(import.meta.filename, ["holder", String(process.pid)]);
	await new Promise((resolve) => holder.once("message", resolve));
	console.log(`2. while process ${holder.pid} holds it: ${await processLockState(name, context)}`);
	const waiting = processLock(name, context);

	// 3. The holder is killed with SIGKILL: no exit hook, no release. Its lock ends with it; the waiter's connection to
	//    its socket closes, and the waiter takes the lock at once.
	const killed = Date.now();
	holder.kill("SIGKILL");
	const lock = await waiting;
	console.log(`3. after the holder's SIGKILL: taken here ${Date.now() - killed} ms later`);
	console.log(`   state: ${await processLockState(name, context)}`);

	// 4. A release frees it, here as for every process of this user, whatever its environment (TMPDIR, `env -i`).
	await lock.release();
	console.log(`4. after the release: ${await processLockState(name, context)}`);
}
