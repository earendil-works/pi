// A preload (`node --import`) that holds a launched p3 server or supervisor still at one point, for the tests of what
// the commands do meanwhile (`commands.ts`). `P3_TEST_GATE` names a directory, `P3_TEST_GATE_AT` the point:
// - `lock`: the server holds the data directory's lock and has not said who it is (its `starting` record not in place);
// - `plugins`: its record says `starting`, its plugins are being found;
// - `running`: its record says `running`, and its start has not returned yet;
// - `supervisor`: a supervisor, before it tries for its lock;
// - `supervisor-exit`: a supervisor whose server ended, before it removes its record and lets its lock go.
// There the process writes its pid into `<gate>/held`, and goes on once `<gate>/go-<pid>` exists. Each process holds
// once (a supervisor's next server holds again); the others that load the preload pass.

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const gate = process.env.P3_TEST_GATE;
const at = process.env.P3_TEST_GATE_AT;
let held = false;

/** Holds this process still until the test opens the gate, the first time only. */
async function hold(): Promise<void> {
	if (gate === undefined || held) return;
	held = true;
	fs.writeFileSync(join(gate, "held"), String(process.pid));
	while (!fs.existsSync(join(gate, `go-${process.pid}`))) await sleep(5);
}

/** The state a record file about to be renamed into place says. */
function stateOf(path: fs.PathLike): string | undefined {
	return (JSON.parse(fs.readFileSync(path, "utf8")) as { state?: string }).state;
}

/** Whether this process is a supervisor: its script is `supervisor.ts` or the release's `supervisor.js`. */
const supervisor = /\/supervisor\.(ts|js)$/.test(process.argv[1] ?? "");

// Before the supervisor's own module runs: a preload's top-level await holds the entry back.
if (at === "supervisor" && supervisor) await hold();

const { readFile, rename, rm } = fs.promises;
// Patched where the server's modules find them: `syncBuiltinESMExports` updates `import { rename } from "node:fs/promises"`.
fs.promises.rename = async (from, to) => {
	const record = String(to).endsWith("/server.json") ? stateOf(from) : undefined;
	if (at === "lock" && record === "starting") await hold();
	await rename(from, to);
	if (at === "running" && record === "running") await hold();
};
fs.promises.readFile = (async (path: fs.PathLike, ...rest: []) => {
	if (at === "plugins" && String(path).endsWith("/plugins/sessions/package.json")) await hold();
	return readFile(path, ...rest);
}) as typeof readFile;
fs.promises.rm = async (path, options) => {
	if (at === "supervisor-exit" && supervisor && String(path).endsWith("/supervisor.json")) await hold();
	return rm(path, options);
};
syncBuiltinESMExports();
