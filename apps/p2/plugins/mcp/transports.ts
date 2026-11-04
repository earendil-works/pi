// How an instance opens its MCP transport, by where it runs: a program on the p2 host (`StdioTransport`), a program
// on an environment through its pi-env daemon (`PipeTransport` over `openProcess`, through `cmd.exe` on Windows), or
// a Streamable HTTP server.

import { posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { type Connection, nodePlatform, openProcess, RemoteError } from "@earendil-works/pi-env";
import { type McpTransport, PipeTransport, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { expandHostVariables } from "./config.ts";
import type { EnvConnections } from "./environments.ts";
import type { Connect, RemoteConnect } from "./placement.ts";
import { windowsCommand } from "./windows-command.ts";

/** A transport, not started yet, and the `file://` roots its client offers. */
export type Opened = { readonly transport: McpTransport; readonly roots: readonly string[] };

/** How one instance opens transports, holding what they need meanwhile (an environment's connection) until `release`. */
export type Transports = { open(): Promise<Opened>; release(): void };

/** The environment's daemon predates the `process` operation: retrying does not help, updating it does. */
export class DaemonTooOldError extends Error {}

/** The transports of an instance connecting as `connect`; an environment's connection is taken from `envs`. */
export function transportsFor(connect: Connect, envs: EnvConnections): Transports {
	switch (connect.kind) {
		case "remote": {
			const lease = envs.acquire(connect.environment, connect.config);
			return { open: () => remoteTransport(connect, lease.connection), release: () => lease.release() };
		}
		case "host":
			return {
				open: async () => ({
					transport: new StdioTransport({
						command: connect.command,
						args: connect.args,
						cwd: connect.cwd,
						env: connect.hostVariables ? expandValues(connect.env) : { ...connect.env },
						stderr: "pipe",
					}),
					roots: connect.roots,
				}),
				release: () => {},
			};
		case "http":
			return {
				open: async () => ({
					transport: new StreamableHttpTransport({ url: connect.url, headers: expandValues(connect.headers) }),
					roots: [],
				}),
				release: () => {},
			};
		case "unplaced":
			return {
				open: async () => {
					throw new Error(connect.reason);
				},
				release: () => {},
			};
	}
}

/**
 * A program on an environment: `~` is the remote home, relative paths are relative to the location's cwd there (else
 * the home), in the remote system's path rules; on Windows, through `cmd.exe` unless it is an `.exe` or `.com`.
 */
async function remoteTransport(connect: RemoteConnect, connection: Connection): Promise<Opened> {
	const info = await connection.info();
	const windows = nodePlatform(info).platform === "win32";
	const paths = windows ? win32 : posix;
	const expandHome = (value: string): string =>
		value === "~" ? info.home : value.startsWith("~/") ? paths.join(info.home, value.slice(2)) : value;
	const cwd = paths.resolve(connect.base ?? info.home, expandHome(connect.cwd));
	const command = expandHome(connect.command);
	const args = connect.args.map(expandHome);
	const launch = windows ? windowsCommand(command, args) : { argv: [command, ...args], env: {} };
	const env = { ...(connect.hostVariables ? expandValues(connect.env) : connect.env), ...launch.env };
	const transport = new PipeTransport({
		open: async ({ onStdout, onStderr }) => {
			try {
				return await openProcess(connection, { cwd, argv: launch.argv, env, onStdout, onStderr });
			} catch (error) {
				if (error instanceof RemoteError && error.code === "not_supported")
					throw new DaemonTooOldError(`the pi-env daemon on ${connect.environment} is too old; update it`);
				throw error;
			}
		},
	});
	return { transport, roots: connect.base === null ? [] : [pathToFileURL(connect.base, { windows }).href] };
}

/** `values` with `${NAME}` from the p2 host's environment (the owner's configuration only). */
function expandValues(values: Readonly<Record<string, string>>): Record<string, string> {
	return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expandHostVariables(value)]));
}
