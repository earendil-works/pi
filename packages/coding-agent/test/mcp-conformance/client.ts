/**
 * Client under test for the official MCP client conformance suite. The suite starts a scenario server
 * and runs this script with the server URL as the last argument, the scenario name in
 * `MCP_CONFORMANCE_SCENARIO`, and scenario data in `MCP_CONFORMANCE_CONTEXT`.
 *
 * It drives the code pi runs for an `mcp.json` HTTP server: `McpServerConnection` connects and calls
 * tools, and `signInMcpServer` runs the OAuth sign-in that `/mcp` starts. The browser is simulated: the
 * authorization URL is fetched without following its redirect, and the redirect is delivered to pi's
 * loopback callback server. Credentials stay in memory.
 *
 * Run through run.ts, which writes the outcome to `PI_MCP_CONFORMANCE_REPORT`.
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import type { McpHttpServerConfig, McpServerEntry } from "../../src/extensions/mcp/config.ts";
import type { McpSignInPrompt } from "../../src/extensions/mcp/oauth.ts";
import {
	createDefaultTransport,
	McpOAuthCredentialStore,
	McpServerConnection,
	signInMcpServer,
} from "../../src/extensions/mcp/runtime.ts";

/**
 * Sign-ins pi asks the user for are not limited, so a user who keeps approving them would loop
 * forever against a server that never accepts the granted scope. This simulated user gives up after
 * three, the limit `auth/scope-retry-limit` checks.
 */
const MAX_SIGN_INS = 3;
const REQUEST_TIMEOUT_SECONDS = 20;

interface ToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

/** Tool calls of a scenario after connecting. `undefined` for scenarios this client does not know. */
function toolCalls(scenario: string, connection: McpServerConnection): ToolCall[] | undefined {
	if (scenario.startsWith("auth/")) return [{ name: "test-tool", arguments: {} }];
	switch (scenario) {
		case "initialize":
			return [];
		case "tools_call":
			return [{ name: "add_numbers", arguments: { a: 2, b: 3 } }];
		case "sse-retry":
			return [{ name: "test_reconnection", arguments: {} }];
		case "elicitation-sep1034-client-defaults":
			return [{ name: "test_client_elicitation_defaults", arguments: {} }];
		case "json-schema-2020-12-preservation": {
			// The server compares the echoed schema with the one it listed, to detect dropped keywords.
			const tool = connection.tools.find((candidate) => candidate.name === "json_schema_2020_12_tool");
			if (!tool) throw new Error("json_schema_2020_12_tool was not listed");
			return [{ name: "json_schema_echo", arguments: { schema: tool.inputSchema } }];
		}
		default:
			return undefined;
	}
}

function log(message: string): void {
	process.stderr.write(`[pi-conformance] ${message}\n`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readContext(): Record<string, unknown> {
	const raw = process.env.MCP_CONFORMANCE_CONTEXT;
	if (!raw) return {};
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("MCP_CONFORMANCE_CONTEXT is not an object");
	}
	return parsed as Record<string, unknown>;
}

function isLoopback(url: URL): boolean {
	return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** What a browser does with the authorization URL when the user approves at once. */
async function visitAuthorizationUrl(url: URL): Promise<void> {
	const response = await fetch(url, { redirect: "manual" });
	const location = response.headers.get("location");
	if (!location) throw new Error(`Authorization endpoint answered ${response.status} without a redirect`);
	const callback = new URL(location, url);
	if (callback.protocol !== "http:" || !isLoopback(callback)) {
		throw new Error(`Authorization endpoint redirected to ${callback.origin}, not to the loopback callback`);
	}
	log(`delivering authorization response to ${callback.origin}${callback.pathname}`);
	await (await fetch(callback)).text();
}

function simulatedBrowser(): McpSignInPrompt {
	let visit: Promise<void> | undefined;
	return {
		showAuthorizationUrl(url) {
			log(`authorization URL: ${url.origin}${url.pathname}`);
			visit = visitAuthorizationUrl(url);
		},
		async promptForRedirectUrl(signal) {
			try {
				await visit;
			} catch (error) {
				// Cancels the sign-in instead of waiting for a callback that never comes.
				log(`browser failed: ${errorMessage(error)}`);
				return undefined;
			}
			if (!signal.aborted) {
				await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
			}
			return undefined;
		},
	};
}

async function run(serverUrl: string, scenario: string): Promise<void> {
	const context = readContext();
	const config: McpHttpServerConfig = { url: serverUrl, timeout: REQUEST_TIMEOUT_SECONDS };
	if (typeof context.client_id === "string") {
		// Pre-registered clients are configured in `mcp.json`.
		config.oauth = {
			clientId: context.client_id,
			clientSecret: typeof context.client_secret === "string" ? context.client_secret : undefined,
		};
	}
	const entry: McpServerEntry = { name: "conformance", config, source: "conformance" };
	const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
	const connection = new McpServerConnection({
		entry,
		cwd: tmpdir(),
		createTransport: createDefaultTransport,
		credentials,
		onTools: () => {},
	});

	let signIns = 0;
	/** Run `operation`, signing in like a user answering `/mcp` whenever the server asks for it. */
	const withSignIn = async <T>(operation: () => Promise<T>): Promise<T> => {
		for (;;) {
			try {
				return await operation();
			} catch (error) {
				const url = connection.oauthUrl;
				if (connection.state !== "needs-auth" || !url) throw error;
				if (signIns >= MAX_SIGN_INS) throw new Error(`Still requires sign-in after ${signIns} sign-ins`);
				signIns++;
				log(`sign-in ${signIns}${connection.challenge?.scope ? ` (scope: ${connection.challenge.scope})` : ""}`);
				await signInMcpServer({
					serverUrl: url,
					store: credentials.forServer(entry.name, url),
					settings: connection.oauthSettings(),
					challenge: connection.challenge,
					prompt: simulatedBrowser(),
				});
				connection.challenge = undefined;
			}
		}
	};

	try {
		await withSignIn(() => connection.getClient());
		log(`connected, tools: ${connection.tools.map((tool) => tool.name).join(", ") || "(none)"}`);
		const calls = toolCalls(scenario, connection);
		if (!calls) throw new Error(`Unknown scenario ${scenario}`);
		for (const call of calls) {
			const result = await withSignIn(() => connection.callTool(call.name, call.arguments, {}));
			log(`${call.name}: ${JSON.stringify(result.content)}`);
			if (result.isError) throw new Error(`Tool ${call.name} failed: ${JSON.stringify(result.content)}`);
		}
	} finally {
		await connection.close();
	}
}

async function main(): Promise<number> {
	const serverUrl = process.argv.at(-1);
	const scenario = process.env.MCP_CONFORMANCE_SCENARIO;
	const reportPath = process.env.PI_MCP_CONFORMANCE_REPORT;
	let report: { success: boolean; error?: string };
	if (!serverUrl || !scenario || process.argv.length < 3) {
		report = { success: false, error: "Usage: MCP_CONFORMANCE_SCENARIO=<scenario> client.ts <server-url>" };
	} else {
		try {
			await run(serverUrl, scenario);
			report = { success: true };
		} catch (error) {
			report = { success: false, error: errorMessage(error) };
		}
	}
	if (report.error) log(`error: ${report.error}`);
	if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	return report.success ? 0 : 1;
}

// Exit explicitly: a failed scenario can leave sockets of the server under test open.
process.exit(await main());
