// Trusted bootstrap. No downloaded imports, callbacks or bundle evaluation until all implicit permissions are dropped.

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as module from "node:module";
import * as os from "node:os";
import * as v8 from "node:v8";
import * as workers from "node:worker_threads";

const port = workers.parentPort;
const { source, input } = workers.workerData;
const post = port.postMessage.bind(port);
const permissions = ["fs.read", "fs.write", "worker", "net", "child", "addon", "wasi", "inspector"];
for (const permission of permissions) process.permission.drop(permission);
for (const permission of permissions) {
	if (process.permission.has(permission)) throw new Error("TUI sandbox permission drop failed");
}
const deny = () => {
	throw new Error("Unavailable in the TUI sandbox");
};
// Permission drops protect path opens, but inherited numeric descriptors must not bypass capture or read stdin.
// No filesystem function is a UI capability; keep the facade closed through every built-in alias.
for (const filesystem of [fs.default, fsPromises.default]) {
	for (const [name, value] of Object.entries(filesystem)) {
		if (typeof value === "function")
			Object.defineProperty(filesystem, name, {
				value: deny,
				writable: false,
				configurable: false,
				enumerable: true,
			});
	}
}
for (const name of [
	"writeHeapSnapshot",
	"getHeapSnapshot",
	"queryObjects",
	"setFlagsFromString",
	"takeCoverage",
	"startCpuProfile",
	"startHeapProfile",
]) {
	if (typeof v8.default[name] === "function") v8.default[name] = deny;
}
// Same-process/OS controls are not useful UI capabilities, even when they are not permission-gated.
for (const name of ["kill", "_debugProcess", "_debugEnd"])
	if (typeof process[name] === "function") process[name] = deny;
os.default.setPriority = deny;
for (const name of ["getReport", "writeReport"]) process.report[name] = deny;
for (const name of ["parentPort", "workerData"]) workers.default[name] = undefined;
for (const name of ["getEnvironmentData", "setEnvironmentData", "postMessageToThread", "BroadcastChannel"])
	workers.default[name] = deny;
globalThis.BroadcastChannel = deny;
module.syncBuiltinESMExports();
// The bundle receives only this capability, not a port or Worker object. Raw stdout/stderr are captured by the launcher.
const send = (value) => post({ kind: "event", value });
let handler;
port.on("message", async (message) => {
	try {
		const result = await handler?.(message.value);
		if (message.id !== undefined) post({ kind: "reply", id: message.id, value: result });
	} catch {
		if (message.id !== undefined) post({ kind: "reply", id: message.id, failed: true });
		else post({ kind: "failed" });
	}
});
// Owner-approved dynamic import: the single self-contained server bundle is evaluated only from memory.
const bundle = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
await bundle.default({
	input,
	send,
	onMessage: (next) => {
		handler = next;
	},
});
post({ kind: "ready" });
