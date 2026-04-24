#!/usr/bin/env node
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { createWebServer } from "./server.js";

interface CLIOptions {
	port: number;
	host: string;
	help: boolean;
}

function printHelp(): void {
	console.log(`
Pi Web Server - Browser-based AI coding assistant

Usage: pi-web [options]

Options:
  --port <number>    Port to listen on (default: 8181)
  --host <hostname>  Host to bind to (default: localhost)
  --help             Show this help message

Examples:
  pi-web
  pi-web --port 3000
  pi-web --host 0.0.0.0 --port 8080
`);
}

function parseCLIOptions(): CLIOptions {
	const { values } = parseArgs({
		options: {
			port: { type: "string", default: "8181" },
			host: { type: "string", default: "localhost" },
			help: { type: "boolean", default: false },
		},
	});

	return {
		port: parseInt(values.port || "8181", 10),
		host: values.host || "localhost",
		help: values.help || false,
	};
}

async function main(): Promise<void> {
	const options = parseCLIOptions();

	if (options.help) {
		printHelp();
		process.exit(0);
	}

	const server = createWebServer({
		port: options.port,
		host: options.host,
	});

	await server.start();

	const handleShutdown = async () => {
		console.log("\nShutting down...");
		await server.stop();
		process.exit(0);
	};

	process.on("SIGINT", handleShutdown);
	process.on("SIGTERM", handleShutdown);
}

main().catch((error) => {
	console.error("Failed to start server:", error);
	process.exit(1);
});
