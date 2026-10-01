import { BASH_COMPLETION } from "./bash.ts";
import { ZSH_COMPLETION } from "./zsh.ts";

/**
 * Print a shell completion script for the pipi CLI (`pipi completion <bash|zsh>`).
 *
 * Owned by pi-plus rather than the hub package because it completes the whole
 * CLI surface (hub subcommands plus pi's native commands and flags), not just
 * profile management. Throws on missing/unsupported shells; callers print the
 * error and exit non-zero.
 */
export function dispatchCompletion(argv: string[]): void {
	const shell = argv[0];
	switch (shell) {
		case "zsh":
			process.stdout.write(ZSH_COMPLETION);
			return;
		case "bash":
			process.stdout.write(BASH_COMPLETION);
			return;
		case undefined:
			throw new Error("Error: shell is required. Usage: pipi completion <bash|zsh>");
		default:
			throw new Error(`Unsupported shell: ${shell}. Use 'bash' or 'zsh'.`);
	}
}
