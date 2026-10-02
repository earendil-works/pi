/**
 * `pi mcp`: add, remove, and check MCP servers and sign in to them outside a session. Agents run it
 * through bash to configure servers, verify an `mcp.json` they wrote, and start an OAuth sign-in;
 * the user only approves access in the browser. Running sessions pick up new credentials on their
 * next turn.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME } from "../../config.ts";
import { validateMcpServerConfig } from "../../core/mcp-servers.ts";
import { ProjectTrustStore } from "../../core/trust-manager.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import {
	addMcpServerConfig,
	getMcpToolExposure,
	type LoadedMcpConfig,
	loadMcpConfig,
	type McpServerEntry,
	removeMcpServerConfig,
} from "./config.ts";
import {
	createDefaultTransport,
	McpOAuthCredentialStore,
	McpServerConnection,
	McpServerLog,
	McpSignInCancelledError,
	signInMcpServer,
} from "./runtime.ts";

const HELP = `${chalk.bold("Usage:")}
  ${APP_NAME} mcp add <server> [options] -- <command> [args...]
  ${APP_NAME} mcp add <server> [options] --url <url>
  ${APP_NAME} mcp remove <server> [-l]
  ${APP_NAME} mcp list [--json]
  ${APP_NAME} mcp login <server> [--timeout <seconds>]
  ${APP_NAME} mcp logout <server>

Configure and check MCP servers and sign in to OAuth servers without starting a session.
Reads ~/${CONFIG_DIR_NAME}/agent/mcp.json and, in trusted projects, ${CONFIG_DIR_NAME}/mcp.json.

Commands:
  add <server>            Add or replace a server in mcp.json
  remove <server>         Remove a server from mcp.json
  list                    Show state, tools, and errors (exits 1 on failure)
  login <server>          Sign in through the browser
  logout <server>         Delete the stored OAuth credentials

Options for add and remove:
  -l, --local             Use ${CONFIG_DIR_NAME}/mcp.json in the current project instead of the global file

Options for add:
  --url <url>             Streamable HTTP server URL (instead of a command)
  --env <KEY=VALUE>       Environment variable for a stdio server (repeatable)
  --cwd <dir>             Working directory for a stdio server
  --header <KEY=VALUE>    HTTP header (repeatable)
  --bearer-token-env-var <NAME>
                          Send "Authorization: Bearer \${NAME}"
  --oauth-client-id <id>  Pre-registered OAuth client id
  --oauth-client-secret <secret>
                          OAuth client secret (may be \${NAME} or !command)
  --oauth-callback-port <port>
                          Fixed OAuth callback port
  --oauth-client-name <name>
                          Client name sent when registering with the OAuth server
  --exposure <mode>       codemode (default), deferred, direct, or hidden
  --description <text>    What the server offers, shown in the system prompt

Other options:
  --json                  Print the list as JSON
  --timeout <seconds>     How long login waits for the browser (default: 300)`;

const HELP_HINT = chalk.dim(`Use "${APP_NAME} mcp --help" for usage.`);

const DEFAULT_LOGIN_TIMEOUT_SECONDS = 300;

export interface McpCommandOptions {
	cwd: string;
	agentDir: string;
	/** Defaults to `mcp-auth.json` in the agent directory. */
	credentials?: McpOAuthCredentialStore;
	/** Defaults to the platform browser. */
	openUrl?: (url: string) => void;
	/** Defaults to console output. */
	log?: (line: string) => void;
	error?: (line: string) => void;
}

interface ServerReport {
	name: string;
	scope: string;
	source: string;
	enabled: boolean;
	exposure: string;
	transport: string;
	state: string;
	tools: string[];
	/** Tools whose exposure differs from the server's, from `toolExposure`. */
	toolExposure?: Record<string, string>;
	resources?: number;
	resourceTemplates?: number;
	error?: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function describeTransport(entry: McpServerEntry): string {
	const { config } = entry;
	return "url" in config ? config.url : [config.command, ...(config.args ?? [])].join(" ");
}

function createConnection(entry: McpServerEntry, options: McpCommandOptions, credentials: McpOAuthCredentialStore) {
	return new McpServerConnection({
		entry,
		cwd: options.cwd,
		createTransport: createDefaultTransport,
		credentials,
		log: new McpServerLog(join(options.agentDir, "mcp.log")),
		onTools: () => {},
	});
}

/** Short spellings of options. `-l`/`--local` match `pi install`. */
const OPTION_ALIASES = new Map([["-l", "--local"]]);

interface ParsedOptions {
	positional: string[];
	values: Map<string, string | true>;
	/** Values of `list` options, in order. */
	lists: Map<string, string[]>;
}

/**
 * Parse `--name value` options; returns undefined and reports unknown ones. `--` ends the options,
 * as does reaching `maxPositionals` positional arguments: the remaining arguments are positional,
 * so a command's own options (`add <server> <command> --flag`) are passed through.
 */
function parseOptions(
	args: string[],
	known: Record<string, "flag" | "value" | "list">,
	error: (line: string) => void,
	maxPositionals = Number.POSITIVE_INFINITY,
): ParsedOptions | undefined {
	const positional: string[] = [];
	const values = new Map<string, string | true>();
	const lists = new Map<string, string[]>();
	for (let index = 0; index < args.length; index++) {
		const arg = OPTION_ALIASES.get(args[index]) ?? args[index];
		if (arg === "--" || positional.length >= maxPositionals) {
			positional.push(...args.slice(arg === "--" ? index + 1 : index));
			break;
		}
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const name = arg.slice(2);
		const kind = known[name];
		if (!kind) {
			error(`Unknown option ${arg}.\n${HELP_HINT}`);
			return undefined;
		}
		if (kind === "flag") {
			values.set(name, true);
			continue;
		}
		const value = args[++index];
		if (value === undefined) {
			error(`${arg} needs a value.`);
			return undefined;
		}
		if (kind === "list") lists.set(name, [...(lists.get(name) ?? []), value]);
		else values.set(name, value);
	}
	return { positional, values, lists };
}

/** Run `pi mcp <args>` and return the exit code. */
export async function runMcpCommand(args: string[], options: McpCommandOptions): Promise<number> {
	const log = options.log ?? ((line: string) => console.log(line));
	const error = options.error ?? ((line: string) => console.error(line));
	const [command, ...rest] = args;
	if (command === undefined || command === "help" || args.includes("--help") || args.includes("-h")) {
		log(HELP);
		return 0;
	}

	const projectConfig = join(options.cwd, CONFIG_DIR_NAME, "mcp.json");
	if (command === "add" || command === "remove") {
		return command === "add"
			? add(rest, projectConfig, options, log, error)
			: remove(rest, projectConfig, options, log, error);
	}
	const projectTrusted = new ProjectTrustStore(options.agentDir).get(options.cwd) === true;
	const loaded = loadMcpConfig({ agentDir: options.agentDir, cwd: options.cwd, projectTrusted });
	const untrustedNote =
		!projectTrusted && existsSync(projectConfig)
			? `${projectConfig} is ignored because the project is not trusted. Start ${APP_NAME} in the project to trust it.`
			: undefined;
	const credentials = options.credentials ?? new McpOAuthCredentialStore();

	switch (command) {
		case "list": {
			const parsed = parseOptions(rest, { json: "flag" }, error);
			if (!parsed) return 1;
			if (parsed.positional.length > 0) {
				error(`Usage: ${APP_NAME} mcp list [--json]\n${HELP_HINT}`);
				return 1;
			}
			return list(loaded, parsed.values.has("json"), untrustedNote, options, credentials, log);
		}
		case "login":
		case "logout": {
			const parsed = parseOptions(rest, command === "login" ? { timeout: "value" } : {}, error);
			if (!parsed) return 1;
			const [name, ...extra] = parsed.positional;
			if (!name || extra.length > 0) {
				error(`Usage: ${APP_NAME} mcp ${command} <server>\n${HELP_HINT}`);
				return 1;
			}
			const entry = loaded.servers.find((server) => server.name === name);
			if (!entry) {
				error(
					`No MCP server named "${name}".${untrustedNote ? ` ${untrustedNote}` : ""} Configured: ${loaded.servers.map((server) => server.name).join(", ") || "none"}.`,
				);
				return 1;
			}
			const connection = createConnection(entry, options, credentials);
			const url = connection.oauthUrl;
			if (!url) {
				error(`MCP server "${name}" does not use OAuth. Only HTTP servers without an Authorization header do.`);
				return 1;
			}
			if (command === "logout") {
				const removed = credentials.remove(name, url);
				log(removed ? `Signed out of MCP server "${name}".` : `No stored credentials for MCP server "${name}".`);
				return 0;
			}
			const timeout = Number(parsed.values.get("timeout") ?? DEFAULT_LOGIN_TIMEOUT_SECONDS);
			if (!Number.isFinite(timeout) || timeout <= 0) {
				error("--timeout must be a positive number of seconds.");
				return 1;
			}
			try {
				return await login(entry, connection, url, timeout * 1000, options, credentials, log, error);
			} finally {
				await connection.close();
			}
		}
		default:
			error(`Unknown mcp command "${command}".\n${HELP_HINT}`);
			return 1;
	}
}

/** Parse `KEY=VALUE` pairs of a repeatable option into a record. */
function parsePairs(option: string, pairs: string[] | undefined, error: (line: string) => void) {
	if (!pairs) return {};
	const record: Record<string, string> = {};
	for (const pair of pairs) {
		const separator = pair.indexOf("=");
		if (separator <= 0) {
			error(`--${option} expects KEY=VALUE, got "${pair}".`);
			return undefined;
		}
		record[pair.slice(0, separator)] = pair.slice(separator + 1);
	}
	return record;
}

function add(
	args: string[],
	projectConfig: string,
	options: McpCommandOptions,
	log: (line: string) => void,
	error: (line: string) => void,
): number {
	const usage = `Usage: ${APP_NAME} mcp add <server> [options] (--url <url> | -- <command> [args...])\n${HELP_HINT}`;
	const parsed = parseOptions(
		args,
		{
			local: "flag",
			url: "value",
			env: "list",
			cwd: "value",
			header: "list",
			"bearer-token-env-var": "value",
			"oauth-client-id": "value",
			"oauth-client-secret": "value",
			"oauth-callback-port": "value",
			"oauth-client-name": "value",
			exposure: "value",
			description: "value",
		},
		error,
		2,
	);
	if (!parsed) return 1;
	const { positional, values, lists } = parsed;
	const [name, ...command] = positional;
	const url = values.get("url");
	if (!name || (url === undefined) === (command.length === 0)) {
		error(usage);
		return 1;
	}
	const value = (option: string) => {
		const found = values.get(option);
		return typeof found === "string" ? found : undefined;
	};
	const exposure = value("exposure");
	const httpOnly = [
		"header",
		"bearer-token-env-var",
		"oauth-client-id",
		"oauth-client-secret",
		"oauth-callback-port",
		"oauth-client-name",
	];
	const stdioOnly = ["env", "cwd"];
	const misplaced = (url === undefined ? httpOnly : stdioOnly).find(
		(option) => values.has(option) || lists.has(option),
	);
	if (misplaced) {
		error(`--${misplaced} only applies to ${url === undefined ? "HTTP servers (--url)" : "stdio servers"}.`);
		return 1;
	}

	let config: Record<string, unknown>;
	if (typeof url === "string") {
		const headers = parsePairs("header", lists.get("header"), error);
		if (!headers) return 1;
		const bearer = value("bearer-token-env-var");
		if (bearer !== undefined) headers.Authorization = `Bearer \${${bearer}}`;
		const port = value("oauth-callback-port");
		const oauth = {
			...(value("oauth-client-id") === undefined ? {} : { clientId: value("oauth-client-id") }),
			...(value("oauth-client-secret") === undefined ? {} : { clientSecret: value("oauth-client-secret") }),
			...(port === undefined ? {} : { callbackPort: Number(port) }),
			...(value("oauth-client-name") === undefined ? {} : { clientName: value("oauth-client-name") }),
		};
		config = {
			url,
			...(Object.keys(headers).length > 0 ? { headers } : {}),
			...(Object.keys(oauth).length > 0 ? { oauth } : {}),
		};
	} else {
		const env = parsePairs("env", lists.get("env"), error);
		if (!env) return 1;
		const [executable, ...commandArgs] = command;
		config = {
			command: executable,
			...(commandArgs.length > 0 ? { args: commandArgs } : {}),
			...(Object.keys(env).length > 0 ? { env } : {}),
			...(value("cwd") === undefined ? {} : { cwd: value("cwd") }),
		};
	}
	if (exposure !== undefined) config.exposure = exposure;
	const description = value("description");
	if (description !== undefined) config.description = description;
	const validated = validateMcpServerConfig(name, config);
	if (typeof validated === "string") {
		error(validated);
		return 1;
	}

	const project = values.has("local");
	const path = project ? projectConfig : join(options.agentDir, "mcp.json");
	const scope = project ? "project" : "global";
	let replaced: boolean;
	try {
		replaced = addMcpServerConfig(path, name, validated);
	} catch (addError) {
		error(`Could not update ${path}: ${errorMessage(addError)}`);
		return 1;
	}
	log(`${replaced ? "Replaced" : "Added"} ${scope} MCP server "${name}" in ${path}.`);
	if (project && new ProjectTrustStore(options.agentDir).get(options.cwd) !== true) {
		log(`The project is not trusted, so ${path} is ignored until you start ${APP_NAME} in the project and trust it.`);
	}
	// HTTP servers without an Authorization header may use OAuth.
	const mayNeedSignIn =
		"url" in validated &&
		!Object.keys(validated.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
	log(
		`Check it with: ${APP_NAME} mcp list${mayNeedSignIn ? `. If it requires sign-in: ${APP_NAME} mcp login ${name}` : ""}`,
	);
	return 0;
}

function remove(
	args: string[],
	projectConfig: string,
	options: McpCommandOptions,
	log: (line: string) => void,
	error: (line: string) => void,
): number {
	const parsed = parseOptions(args, { local: "flag" }, error);
	if (!parsed) return 1;
	const [name, ...extra] = parsed.positional;
	if (!name || extra.length > 0) {
		error(`Usage: ${APP_NAME} mcp remove <server> [-l]\n${HELP_HINT}`);
		return 1;
	}
	const project = parsed.values.has("local");
	const globalConfig = join(options.agentDir, "mcp.json");
	const path = project ? projectConfig : globalConfig;
	const scope = project ? "project" : "global";
	let removed: boolean;
	try {
		removed = removeMcpServerConfig(path, name);
	} catch (removeError) {
		error(`Could not update ${path}: ${errorMessage(removeError)}`);
		return 1;
	}
	if (removed) {
		log(`Removed ${scope} MCP server "${name}" from ${path}.`);
		return 0;
	}
	const other = loadMcpConfig({ agentDir: options.agentDir, cwd: options.cwd, projectTrusted: true }).servers.find(
		(server) => server.name === name && server.scope !== scope,
	);
	error(
		`No ${scope} MCP server named "${name}" in ${path}.${other ? ` It is defined in ${other.source}${other.scope === "project" ? "; use --local" : "; omit --local"}.` : ""}`,
	);
	return 1;
}

async function list(
	loaded: LoadedMcpConfig,
	json: boolean,
	untrustedNote: string | undefined,
	options: McpCommandOptions,
	credentials: McpOAuthCredentialStore,
	log: (line: string) => void,
): Promise<number> {
	const reports = await Promise.all(
		loaded.servers.map(async (entry): Promise<ServerReport> => {
			const report: ServerReport = {
				name: entry.name,
				scope: entry.scope ?? "global",
				source: entry.source,
				enabled: entry.config.enabled !== false,
				exposure: entry.config.exposure ?? "codemode",
				transport: describeTransport(entry),
				state: "disabled",
				tools: [],
			};
			if (!report.enabled) return report;
			const connection = createConnection(entry, options, credentials);
			try {
				await connection.getClient();
			} catch {
				// The connection records the state and error.
			}
			report.state = connection.state;
			report.tools = connection.tools.map((tool) => tool.name);
			const overrides = connection.tools.flatMap((tool) => {
				const exposure = getMcpToolExposure(entry.config, tool.name);
				return exposure === report.exposure ? [] : [[tool.name, exposure] as const];
			});
			if (overrides.length > 0) report.toolExposure = Object.fromEntries(overrides);
			if (connection.hasResources) {
				report.resources = connection.resources.length;
				report.resourceTemplates = connection.resourceTemplates.length;
			}
			if (connection.state !== "connected" && connection.error) report.error = connection.error;
			await connection.close();
			return report;
		}),
	);
	const failed = loaded.errors.length > 0 || reports.some((report) => report.enabled && report.state !== "connected");

	if (json) {
		log(
			JSON.stringify(
				{ servers: reports, errors: loaded.errors, ...(untrustedNote ? { note: untrustedNote } : {}) },
				null,
				2,
			),
		);
		return failed ? 1 : 0;
	}
	if (reports.length === 0 && loaded.errors.length === 0) {
		log(`No MCP servers configured. Add them to ${join(options.agentDir, "mcp.json")} or .pi/mcp.json.`);
	}
	for (const report of reports) {
		const state =
			report.state === "connected"
				? `connected, ${report.tools.length} tool${report.tools.length === 1 ? "" : "s"}`
				: report.state === "needs-auth"
					? "needs sign-in"
					: report.state;
		log(`${report.name}: ${state} (${report.exposure}, ${report.scope})`);
		log(`  ${report.transport}`);
		if (report.state === "needs-auth") log(`  sign in with: ${APP_NAME} mcp login ${report.name}`);
		if (report.tools.length > 0) {
			const tools = report.tools.map((tool) => {
				const exposure = report.toolExposure?.[tool];
				return exposure ? `${tool} [${exposure}]` : tool;
			});
			log(`  tools: ${tools.join(", ")}`);
		}
		if (report.resources !== undefined) {
			log(`  resources: ${report.resources}, URI templates: ${report.resourceTemplates ?? 0}`);
		}
		if (report.error) log(`  ${report.error.split("\n").join("\n  ")}`);
	}
	for (const configError of loaded.errors) log(`config error: ${configError}`);
	if (untrustedNote) log(untrustedNote);
	return failed ? 1 : 0;
}

async function login(
	entry: McpServerEntry,
	connection: McpServerConnection,
	url: string,
	timeoutMs: number,
	options: McpCommandOptions,
	credentials: McpOAuthCredentialStore,
	log: (line: string) => void,
	error: (line: string) => void,
): Promise<number> {
	const { name } = entry;
	// Connecting first answers whether a sign-in is needed and records the server's challenge.
	try {
		await connection.getClient();
		log(`Already signed in to MCP server "${name}" (${connection.tools.length} tools).`);
		return 0;
	} catch {
		if (connection.state !== "needs-auth") {
			error(`MCP server "${name}" failed to connect: ${connection.error ?? "unknown error"}`);
			return 1;
		}
	}

	const openUrl = options.openUrl ?? openBrowser;
	const interactive = process.stdin.isTTY === true && options.openUrl === undefined;
	try {
		await signInMcpServer({
			serverUrl: url,
			store: credentials.forServer(name, url),
			settings: connection.oauthSettings(),
			challenge: connection.challenge,
			prompt: {
				showAuthorizationUrl: (authorizationUrl) => {
					log(`Sign in to MCP server "${name}" in your browser:\n${authorizationUrl.href}`);
					openUrl(authorizationUrl.href);
				},
				promptForRedirectUrl: (signal) => waitForRedirectUrl(signal, timeoutMs, interactive),
			},
		});
	} catch (signInError) {
		error(
			signInError instanceof McpSignInCancelledError
				? `Sign-in to MCP server "${name}" was cancelled or not completed within ${Math.round(timeoutMs / 1000)} seconds.`
				: `Sign-in to MCP server "${name}" failed: ${errorMessage(signInError)}`,
		);
		return 1;
	}
	connection.challenge = undefined;
	try {
		await connection.reconnect();
	} catch (connectError) {
		error(`Signed in, but ${errorMessage(connectError)}`);
		return 1;
	}
	log(`Signed in to MCP server "${name}" (${connection.tools.length} tools).`);
	return 0;
}

/**
 * The pasted redirect URL in a terminal; otherwise only the browser callback can finish the sign-in.
 * Resolves to undefined (cancelling the sign-in) after `timeoutMs`, or when the callback arrived.
 */
async function waitForRedirectUrl(
	signal: AbortSignal,
	timeoutMs: number,
	interactive: boolean,
): Promise<string | undefined> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	signal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, timeoutMs);
	try {
		if (!interactive) {
			await new Promise<void>((resolve) =>
				controller.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			return undefined;
		}
		const readline = createInterface({ input: process.stdin, output: process.stderr });
		try {
			return await readline.question(
				"If the browser cannot reach this machine, paste the URL it was redirected to: ",
				{ signal: controller.signal },
			);
		} catch {
			return undefined;
		} finally {
			readline.close();
		}
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}
