// A stand-in session worker for the runner's tests: at its start it connects to `gate.sock` in the runner's data
// directory and reports its start and every reload there (one JSON line each). It acts when the test writes a word:
// `locked` (it says it holds the session's lock), `ready` (it says `locked`, then `ready`), `exit` (exits 1), `idle`
// (says `closed`, exits 0), `orphan` (leaves a process of its own group holding its IPC channel, as a tool's process
// may, reports that process's pid as `orphan`, then exits as `idle`), `linger` (says `closed` and stays, deaf to
// `shutdown`), `stubborn` (deaf to `shutdown` and to the server's disconnect, as a worker whose event loop is stuck),
// `mute` (stops answering reloads). As the real worker, it drops a reload that comes before it is ready (and reports
// it `dropped`).

import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { join } from "node:path";

/** A set of worker scripts as the stand-in reads them: only the digests. */
type Scripts = readonly { readonly built: { readonly digest: string } }[];

/** The control messages the stand-in reads (the runner's `ToWorker`, as far as it needs them). */
type Control =
	| { readonly kind: "start"; readonly dir: string; readonly scripts: Scripts }
	| { readonly kind: "reload"; readonly scripts: Scripts }
	| { readonly kind: "shutdown" };

let gate: Socket | undefined;
let mute = false;
let ready = false;
let deaf = false;
const send = (message: unknown, sent?: () => void): void => {
	process.send?.({ p3: message }, undefined, undefined, sent);
};
const report = (event: string, scripts: Scripts | string): void => {
	const shown = typeof scripts === "string" ? scripts : scripts.map(({ built }) => built.digest).join(",");
	gate?.write(`${JSON.stringify({ event, scripts: shown })}\n`);
};
const commands: Record<string, () => void> = {
	locked: () => send({ kind: "locked" }),
	ready: () => {
		ready = true;
		send({ kind: "locked" });
		send({ kind: "ready", failed: [] });
	},
	exit: () => process.exit(1),
	idle: () => send({ kind: "closed" }, () => process.exit(0)),
	orphan: () => {
		// The runner forks with the channel as descriptor 3, passed on as the orphan's: the server's end stays open.
		const orphan = spawn("sleep", ["60"], { detached: true, stdio: ["ignore", "ignore", "ignore", 3] });
		orphan.unref();
		report("orphan", String(orphan.pid));
		gate?.end(() => commands.idle?.());
	},
	linger: () => {
		deaf = true;
		send({ kind: "closed" });
	},
	stubborn: () => {
		deaf = true;
	},
	mute: () => {
		mute = true;
	},
};
process.on("message", (message: { readonly p3?: Control }) => {
	const control = message.p3;
	if (control?.kind === "start") {
		gate = connect(join(control.dir, "..", "..", "gate.sock"));
		gate.setEncoding("utf8");
		gate.on("data", (words: string) => {
			for (const word of words.split("\n").filter(Boolean)) commands[word]?.();
		});
		report("start", control.scripts);
	} else if (control?.kind === "reload") {
		report(ready ? "reload" : "dropped", control.scripts);
		if (ready && !mute) send({ kind: "reloaded", failed: [] });
	} else if (control?.kind === "shutdown" && !deaf) process.exit(0);
});
process.on("disconnect", () => {
	if (!deaf) process.exit(0);
});
