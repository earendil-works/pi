import { homedir } from "node:os";
import { join } from "node:path";
import { sendDevCommand } from "../src/hosts/dev-channel.ts";
import { parseDevCommand } from "../src/runtime/dev-protocol.ts";

try {
	const args = process.argv.slice(2);
	if (args.includes("--restart") && args.length !== 1)
		throw new Error("--restart cannot be combined with plugin names");
	const command = parseDevCommand(
		args[0] === "--restart" ? { action: "restart" } : { action: "reload", ...(args.length ? { plugins: args } : {}) },
	);
	const result = await sendDevCommand(process.env.P2_DATA_DIR ?? join(homedir(), ".pi", "p2"), command);
	console[result.ok ? "log" : "error"](result.message);
	if (!result.ok) process.exitCode = 1;
} catch (error) {
	console.error(`Reload refused: ${error.message}`);
	process.exitCode = 1;
}
