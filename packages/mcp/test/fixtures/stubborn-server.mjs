// Answers initialize, spawns a grandchild that outlives stdin, and ignores stdin EOF and SIGTERM.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

process.on("SIGTERM", () => {});
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
	stdio: "ignore",
});
console.error(`grandchild ${grandchild.pid}`);
setInterval(() => {}, 1000);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
	const message = JSON.parse(line);
	if (message.method !== "initialize") return;
	const result = {
		protocolVersion: "2025-06-18",
		capabilities: {},
		serverInfo: { name: "stubborn-fixture", version: "1.0.0" },
	};
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
});
