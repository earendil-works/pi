/**
 * Wrapper for packages/coding-agent/src/core/slash-commands.ts.
 *
 * Pass-through except BUILTIN_SLASH_COMMANDS: the /login entry is dropped, so
 * the TUI neither documents nor autocompletes it — pi-plus moves provider
 * login to `pipi profile add <name> -p <provider>`, which stores credentials
 * in the profile's isolated agent dir (the TUI dialog would write to whatever
 * agent dir the session happens to run under). The interactive-mode wrapper
 * stubs the runtime handler for typed "/login" as well.
 */
export * from "../../../../coding-agent/src/core/slash-commands.ts";

import {
	type BuiltinSlashCommand,
	BUILTIN_SLASH_COMMANDS as upstreamBuiltinSlashCommands,
} from "../../../../coding-agent/src/core/slash-commands.ts";

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = upstreamBuiltinSlashCommands.filter(
	(command) => command.name !== "login",
);
