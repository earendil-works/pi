/**
 * Wrapper for packages/coding-agent/src/cli/args.ts.
 *
 * Pass-through except printHelp: appends a "Profile commands (pi-plus)" section
 * documenting the hub features (profile management, use/unuse, shell
 * completion, --as) so `pipi --help` covers the whole CLI surface.
 * The upstream help text already prints "pipi" because upstream args.ts's own
 * ../config.ts import resolves through the plus config redirect.
 */
export * from "../../../../coding-agent/src/cli/args.ts";

import { printHelp as upstreamPrintHelp } from "../../../../coding-agent/src/cli/args.ts";
import { APP_NAME } from "../../../../plus/src/coding-agent/core/config.ts";

type ExtensionFlag = Parameters<typeof upstreamPrintHelp>[0];

export function printHelp(extensionFlags?: ExtensionFlag): void {
	upstreamPrintHelp(extensionFlags);
	const row = (command: string, description: string) => `  ${APP_NAME} ${command}`.padEnd(62) + description;
	console.log(`Profile commands (pi-plus):
${row("profile <add|update|list|view|remove|rename|default>", "Manage pi agent profiles")}
${row("use [name]", "Set or show the default profile")}
${row("unuse", "Unset the default profile (run plain pi)")}
${row("completion <bash|zsh>", "Print a shell completion script")}
${row("--as <name>", "Run a single invocation under a profile")}`);
}
