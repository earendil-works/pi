/**
 * Run one prompt through a Pi RPC child process.
 *
 * Build the coding-agent package first, then run:
 * npx tsx examples/rpc-client.ts "Explain this repository"
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";

const exampleDirectory = dirname(fileURLToPath(import.meta.url));
const prompt = process.argv.slice(2).join(" ") || "Explain this repository in one paragraph.";

const client = new RpcClient({
	cliPath: join(exampleDirectory, "../dist/cli.js"),
	args: ["--no-session"],
});

const unsubscribe = client.onEvent((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	} else if (event.type === "tool_execution_start") {
		process.stderr.write(`\n[tool: ${event.toolName}]\n`);
	}
});

try {
	await client.start();
	await client.promptAndWait(prompt);
	process.stdout.write("\n");
} finally {
	unsubscribe();
	await client.stop();
}
