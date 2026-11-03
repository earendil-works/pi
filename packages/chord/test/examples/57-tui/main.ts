// The terminal surface (slice 11 §4): the board (example 56's app) with a terminal client. The server builds the
// terminal's base bundle from the app's terminal entry (`56-web/tui/main.ts`) and serves the plugins' terminal facets
// as registered scripts, like the web's. The client's launcher (trusted, Node 26.5.1 or later) signs in with the owner
// token file, downloads the bundle and the scripts and runs them in its sandbox, always: a child process without file
// system, processes, network or terminal, its link and its actions relayed and confirmed by the launcher.
// Run from packages/chord (with Node 26.5.1 or later the launcher runs here on a scripted terminal; `--serve` keeps the
// board running for `terminal.ts`):
//   node --conditions=source --experimental-strip-types test/examples/57-tui/main.ts
import { rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { TuiScripts } from "../../../src/index.ts";
import { requireSandboxNode, startTerminal } from "../../../src/node/tui/index.ts";
import { boardDirectories, startBoard } from "../56-web/start.ts";

const { base, dataDir, root } = await boardDirectories();
const app = await startBoard(dataDir, root, context);
const url = new URL(app.ownerLink()).origin;

// 1. What a launcher downloads: the base bundle (an ES module for the sandbox) and the terminal plugins' scripts.
const scripts = await app.host.get(TuiScripts, {}, context);
console.log("1. terminal base bundle:", app.tui?.base);
console.log(
	"   terminal plugins:",
	scripts.set.value.plugins.map(({ name, url: path }) => `${name} ${path}`).join(", "),
);
scripts.release();

// 2. A terminal client, when this Node can sandbox it: a scripted terminal (pipes), its frames shown as text.
let sandboxed = true;
try {
	requireSandboxNode();
} catch (error) {
	sandboxed = false;
	console.log(`2. ${(error as Error).message}: run terminal.ts under a newer Node to see the client.`);
}
if (sandboxed) {
	const input = new PassThrough();
	const output = Object.assign(new PassThrough(), { columns: 60, rows: 10 });
	let frames = "";
	output.on("data", (chunk: Buffer) => {
		frames += chunk.toString();
	});
	const terminal = await startTerminal({
		url,
		credentials: { kind: "file", path: app.ownerTokenFile },
		input,
		output,
	});
	while (!frames.includes("Notes")) await new Promise((resolve) => setTimeout(resolve, 20));
	// Escape sequences stripped for the console.
	const text = frames
		.split("\x1b[2J\x1b[H")
		.at(-1)!
		.replace(/\x1b\[[0-9;]*m/g, "");
	console.log("2. the terminal shows:");
	for (const line of text.trim().split("\r\n")) console.log(`   ${line}`);
	input.write("q");
	console.log("   exit code:", await terminal.exited);
}

if (process.argv.includes("--serve")) {
	console.log(`Board at ${url}; token file ${app.ownerTokenFile}`);
	console.log(`Run: node26 --conditions=source test/examples/57-tui/terminal.ts ${url} ${app.ownerTokenFile}`);
} else {
	await app.close(context);
	await rm(base, { recursive: true, force: true });
}
