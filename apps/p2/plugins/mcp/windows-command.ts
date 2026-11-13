// How a stdio server starts on a Windows environment: the pi-env daemon starts `.exe` and `.com` programs directly
// and refuses batch files (`npx` is `npx.cmd`), so every other command runs through `cmd.exe`, quoted as cross-spawn
// quotes it for Node on Windows.

import { win32 } from "node:path";

/** The argv to start and the variables to add to the program's environment. */
export type WindowsCommand = { readonly argv: readonly string[]; readonly env: Readonly<Record<string, string>> };

/** The variable holding the quoted command line `cmd.exe` runs. */
const COMMAND_VARIABLE = "P2_MCP_COMMAND";

const EXECUTABLE = /\.(?:com|exe)$/i;

const CMD_SHIM = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;

/**
 * `command` with `args` as the daemon starts it on Windows: directly for an `.exe` or `.com` path, else through
 * `cmd.exe /d /s /c`, which finds `npx.cmd` for `npx` through `PATHEXT` as a shell would.
 *
 * The daemon quotes every argv element itself (libuv's rules) and has no verbatim mode, so a command line in an
 * argument would reach `cmd.exe` with its quotes escaped as `\"`, which `cmd.exe` does not understand. The command
 * line goes in an environment variable instead, and `cmd.exe` gets `%P2_MCP_COMMAND%`, which needs no quoting: it
 * expands the variable before it parses quotes and `^` escapes, so it reads the line as cross-spawn's verbatim one.
 */
export function windowsCommand(command: string, args: readonly string[]): WindowsCommand {
	if (EXECUTABLE.test(command)) return { argv: [command, ...args], env: {} };
	// A cmd-shim in node_modules\.bin passes its arguments through a second cmd.exe parse: their `^` escapes twice.
	const quote = CMD_SHIM.test(command) ? (arg: string) => escapeCommand(escapeArgument(arg)) : escapeArgument;
	const line = [escapeCommand(win32.normalize(command)), ...args.map(quote)].join(" ");
	return { argv: ["cmd.exe", "/d", "/s", "/c", `%${COMMAND_VARIABLE}%`], env: { [COMMAND_VARIABLE]: line } };
}

/** cmd.exe's meta characters (cross-spawn's list, after robvanderwoude.com/escapechars.php). */
const META = /([()\][%!^"`<>&|;, *?])/g;

/** The program's name for cmd.exe: every meta character escaped with `^` (cross-spawn's `escapeCommand`). */
function escapeCommand(command: string): string {
	return command.replace(META, "^$1");
}

/**
 * One argument for cmd.exe and then the program's own parsing (qntm.org/cmd, as cross-spawn): backslashes before a
 * quote or the end doubled, quotes escaped, the whole quoted, then every meta character escaped with `^`.
 */
function escapeArgument(arg: string): string {
	// The lookahead form keeps the regular expressions from backtracking on long runs of backslashes (cross-spawn #160).
	return escapeCommand(`"${arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1")}"`);
}
