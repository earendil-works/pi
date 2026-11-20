// A stand-in session worker for the runner's tests: at its start it connects to `gate.sock` in the runner's data
// directory and reports its start and every reload there (one JSON line each); it says `ready`, exits 1, leaves idle
// (`closed`, exit 0) or stops answering reloads (`mute`) when the test writes that word. As the real worker, it drops a
// reload that comes before it is ready (and reports it `dropped`).

import { connect } from "node:net";
import { join } from "node:path";

let gate;
let mute = false;
let ready = false;
const send = (message) => process.send({ p3: message });
const key = (scripts) => scripts.map(({ built }) => built.digest).join(",");
const report = (event, scripts) => gate.write(`${JSON.stringify({ event, scripts: key(scripts) })}\n`);
const commands = {
	ready: () => {
		ready = true;
		send({ kind: "ready", failed: [] });
	},
	exit: () => process.exit(1),
	idle: () => process.send({ p3: { kind: "closed", reason: "idle" } }, () => process.exit(0)),
	mute: () => {
		mute = true;
	},
};
process.on("message", (message) => {
	const control = message?.p3;
	if (control?.kind === "start") {
		gate = connect(join(control.dir, "..", "..", "gate.sock"));
		gate.setEncoding("utf8");
		gate.on("data", (words) => {
			for (const word of words.split("\n").filter(Boolean)) commands[word]();
		});
		report("start", control.scripts);
	} else if (control?.kind === "reload") {
		report(ready ? "reload" : "dropped", control.scripts);
		if (ready && !mute) send({ kind: "reloaded", failed: [] });
	} else if (control?.kind === "shutdown") process.exit(0);
});
process.on("disconnect", () => process.exit(0));
