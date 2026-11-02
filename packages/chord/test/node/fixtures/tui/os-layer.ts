// The operating system's layer of the terminal's sandbox alone, for the TUI tests (Node 26.5.1 or later): starts a
// child as the sandbox starts one (its flags, environment, pipes and private directory) but running the probe below
// instead of the bootstrap, so the probe has every builtin and Node's own `process`, as code that got past the
// JavaScript layer would. Prints the probe's outcomes as JSON. Run it on a pseudo-terminal: the probe looks for one.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOTSTRAP_FILE, sandboxEnvironment, sandboxFlags } from "../../../../src/node/tui/sandbox.ts";

/** Each attempt with Node's own modules; `ok` when it got through. */
const PROBE = `
const outcomes = {};
const attempt = async (name, run) => {
	try {
		await run();
		outcomes[name] = "ok";
	} catch (error) {
		outcomes[name] = String(error.code ?? error.message);
	}
};
const port = Number(process.argv[2]);
(async () => {
	const tty = require("node:tty");
	const fs = require("node:fs");
	await attempt("a terminal descriptor", () => {
		const found = [];
		for (let fd = 0; fd < 256; fd++) if (tty.isatty(fd)) found.push(fd);
		if (found.length === 0) throw new Error("none");
	});
	await attempt("open /dev/tty", () => fs.openSync("/dev/tty", "r+"));
	await attempt("read a file", () => fs.readFileSync("/etc/hostname"));
	await attempt("list its directory", () => fs.readdirSync("."));
	await attempt("write a file", () => fs.writeFileSync("written", "x"));
	await attempt("node:sqlite", () => {
		if (process.getBuiltinModule("node:sqlite") === undefined) throw new Error("absent");
	});
	await attempt("require sqlite", () => require("node:sqlite"));
	await attempt("net.connect", () => new Promise((resolve, reject) => {
		const socket = require("node:net").connect(port, "127.0.0.1");
		socket.on("connect", () => (socket.destroy(), resolve()));
		socket.on("error", reject);
	}));
	await attempt("fetch", () => fetch("http://127.0.0.1:" + port + "/"));
	await attempt("a child process", () => require("node:child_process").spawnSync("true"));
	await attempt("a worker", () => new (require("node:worker_threads").Worker)("1", { eval: true }));
	await attempt("an addon", () => process.dlopen({ exports: {} }, "/nonexistent.node"));
	await attempt("the inspector", () => require("node:inspector").open(0));
	await attempt("an environment", () => {
		const names = Object.keys(process.env).filter((name) => name !== "LD_LIBRARY_PATH");
		if (names.length === 0) throw new Error("empty");
	});
	// Known gaps: signals to the user's processes, the machine's details, whether a path exists.
	await attempt("signal the launcher", () => process.kill(process.ppid, 0));
	await attempt("os details", () => require("node:os").userInfo().username);
	// Opus E13, a Node gap: module resolution tells whether a file exists (denied for one that does, not found for one
	// that does not).
	await attempt("whether a path exists", () => {
		const code = (path) => {
			try {
				require.resolve(path);
				return "resolved";
			} catch (error) {
				return error.code;
			}
		};
		if (code("/etc/hostname") === code("/etc/no-such-file-chord")) throw new Error("no difference");
	});
	process.stdout.write(JSON.stringify(outcomes));
})();
`;

const server = createServer((socket) => socket.destroy());
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const directory = await mkdtemp(join(tmpdir(), "chord-tui-"));
await writeFile(join(directory, BOOTSTRAP_FILE), PROBE);
const port = String((server.address() as { port: number }).port);
const child = spawn(process.execPath, [...sandboxFlags(join(directory, BOOTSTRAP_FILE)), port], {
	stdio: ["pipe", "pipe", "pipe"],
	env: sandboxEnvironment(),
	cwd: directory,
});
let output = "";
child.stdout.on("data", (chunk: Buffer) => {
	output += chunk.toString();
});
child.stderr.on("data", (chunk: Buffer) => {
	output += chunk.toString();
});
await new Promise((resolve) => child.on("close", resolve));
server.close();
await rm(directory, { recursive: true, force: true });
process.stdout.write(output);
