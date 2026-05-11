import { isIP } from "node:net";
import type { WebOptions } from "./types.js";

export function parseWebArgs(args: string[]): WebOptions {
	const result: WebOptions = { port: 5173, host: "0.0.0.0", open: true, allowRemote: true, rpcArgs: [] };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") result.help = true;
		else if (arg === "--no-open") result.open = false;
		else if (arg === "--allow-remote") result.allowRemote = true;
		else if (arg === "--port") result.port = parsePort(args[++i], result.port);
		else if (arg.startsWith("--port=")) result.port = parsePort(arg.slice("--port=".length), result.port);
		else if (arg === "--host") result.host = args[++i] ?? result.host;
		else if (arg.startsWith("--host=")) result.host = arg.slice("--host=".length);
		else if (arg === "--token") result.token = args[++i] ?? "";
		else if (arg.startsWith("--token=")) result.token = arg.slice("--token=".length);
		else result.rpcArgs.push(arg);
	}
	return result;
}

function parsePort(value: string | undefined, fallback: number): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65535) return fallback;
	return port;
}

export function usage(): string {
	return `pi web - browser UI for Pi

Usage:
  pi web [--port 5173] [--host 0.0.0.0] [--no-open] [--token token] [pi options...]

Examples:
  pi web
  pi web --port 3000 --model sonnet:high
  pi web --no-open --token automation-token --provider openai --model gpt-5
`;
}

export function isLoopbackHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	if (normalized === "localhost") return true;
	if (normalized === "::1" || normalized === "[::1]") return true;
	const ipVersion = isIP(normalized);
	if (ipVersion === 4) return normalized.startsWith("127.");
	if (ipVersion === 6) return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
	return false;
}

export function assertHostAllowed(options: Pick<WebOptions, "host" | "allowRemote">): void {
	void options;
}
