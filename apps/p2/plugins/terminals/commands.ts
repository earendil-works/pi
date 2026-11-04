// The terminal tool's commands (worker): a tmux command name and its argv, parsed getopt-style as tmux parses them
// (options first, flags combinable as `-lp`, values attached or separate, `--` ends options), into a typed command.
// Nothing is split or unquoted: every argument arrives as the script passed it.

/** What a wait waits for: no output for a while, the program's exit, a regular expression over the new output. */
export type WaitFor =
	| { kind: "none" }
	| { kind: "quiet" }
	| { kind: "exit" }
	| { kind: "match"; pattern: string; ignoreCase: boolean };

/** A wait as asked: what for, and the timeout in seconds when given. */
export type WaitOptions = { wait?: WaitFor; timeout?: number };

export type TerminalCommand =
	| ({ command: "new-window"; name?: string; directory?: string; shellCommand?: string } & WaitOptions)
	| { command: "list-windows" }
	| ({ command: "send-keys"; target: string; literal: boolean; keys: string[] } & WaitOptions)
	| ({ command: "read"; target: string } & WaitOptions)
	| { command: "capture-pane"; target: string; scrollback: number; escapes: boolean }
	| { command: "kill-window"; target: string };

export const COMMANDS = ["new-window", "list-windows", "send-keys", "read", "capture-pane", "kill-window"] as const;
export type CommandName = (typeof COMMANDS)[number];

/** Longest timeout a wait may ask for, in seconds. */
export const MAX_TIMEOUT_S = 120;

/** A command line tmux would refuse: the message says why, tmux-style (`usage: …`). */
export class CommandError extends Error {}

/** Each command's options (a letter, with `:` when it takes a value) and usage line, as tmux prints it. */
const SPECS: Record<CommandName, { options: string; usage: string }> = {
	"new-window": {
		options: "n:c:w:T:",
		usage: "new-window [-n window-name] [-c start-directory] [-w wait] [-T seconds] [shell-command ...]",
	},
	"list-windows": { options: "", usage: "list-windows" },
	"send-keys": { options: "lt:w:T:", usage: "send-keys [-l] [-w wait] [-T seconds] -t target-window key ..." },
	read: { options: "t:w:T:", usage: "read [-w wait] [-T seconds] -t target-window" },
	"capture-pane": { options: "ept:S:", usage: "capture-pane [-ep] [-S start-line] -t target-window" },
	"kill-window": { options: "t:", usage: "kill-window -t target-window" },
};

/** Lines of scrollback `capture-pane -S -` asks for: all the host returns. */
const ALL_SCROLLBACK = 100_000;

/** Parses one command; throws a `CommandError` for anything tmux would refuse. */
export function parseCommand(command: CommandName, args: readonly string[]): TerminalCommand {
	const spec = SPECS[command];
	const { options, rest } = getopt(command, spec, args);
	const usage = () => new CommandError(`usage: ${spec.usage}`);
	const target = () => {
		const value = options.get("t");
		if (value === undefined || value === "") throw usage();
		return value;
	};
	const waits = (): WaitOptions => {
		const wait = options.get("w");
		const timeout = options.get("T");
		return {
			...(wait === undefined ? {} : { wait: parseWait(command, wait) }),
			...(timeout === undefined ? {} : { timeout: parseTimeout(command, timeout) }),
		};
	};
	switch (command) {
		case "new-window": {
			const name = options.get("n");
			const directory = options.get("c");
			return {
				command,
				...(name ? { name } : {}),
				...(directory ? { directory } : {}),
				...(rest.length > 0 ? { shellCommand: rest.join(" ") } : {}),
				...waits(),
			};
		}
		case "list-windows":
			if (rest.length > 0) throw usage();
			return { command };
		case "send-keys":
			if (rest.length === 0) throw usage();
			return { command, target: target(), literal: options.has("l"), keys: [...rest], ...waits() };
		case "read":
			if (rest.length > 0) throw usage();
			return { command, target: target(), ...waits() };
		case "capture-pane": {
			if (rest.length > 0) throw usage();
			const start = options.get("S");
			return { command, target: target(), scrollback: parseStart(command, start), escapes: options.has("e") };
		}
		case "kill-window":
			if (rest.length > 0) throw usage();
			return { command, target: target() };
	}
}

/**
 * tmux's getopt: options until the first argument that is not one (or `--`); flags combine (`-ep`); an option's value
 * is the rest of its argument or the next argument, even one starting with `-` (`-S -50`).
 */
function getopt(
	command: string,
	spec: { options: string; usage: string },
	args: readonly string[],
): { options: Map<string, string>; rest: string[] } {
	const options = new Map<string, string>();
	let index = 0;
	for (; index < args.length; index++) {
		const arg = args[index] as string;
		if (arg === "--") {
			index++;
			break;
		}
		if (!arg.startsWith("-") || arg === "-") break;
		for (let at = 1; at < arg.length; at++) {
			const letter = arg[at] as string;
			const position = spec.options.indexOf(letter);
			if (position < 0 || letter === ":")
				throw new CommandError(`${command}: unknown option -- ${letter}\nusage: ${spec.usage}`);
			if (spec.options[position + 1] !== ":") {
				options.set(letter, "");
				continue;
			}
			const value = at + 1 < arg.length ? arg.slice(at + 1) : args[++index];
			if (value === undefined)
				throw new CommandError(`${command}: option requires an argument -- ${letter}\nusage: ${spec.usage}`);
			options.set(letter, value);
			break;
		}
	}
	return { options, rest: args.slice(index) };
}

/** `quiet`, `exit`, `none` or `/regex/` (`/regex/i` ignores case). */
function parseWait(command: string, value: string): WaitFor {
	if (value === "quiet" || value === "exit" || value === "none") return { kind: value };
	const match = /^\/(.*)\/(i?)$/s.exec(value);
	if (!match) throw new CommandError(`${command}: invalid wait: ${value} (quiet, exit, none or /regex/)`);
	const pattern = match[1] as string;
	try {
		new RegExp(pattern);
	} catch (error) {
		throw new CommandError(`${command}: invalid regex: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { kind: "match", pattern, ignoreCase: match[2] === "i" };
}

function parseTimeout(command: string, value: string): number {
	const seconds = Number(value);
	if (value.trim() === "" || !Number.isFinite(seconds) || seconds < 0 || seconds > MAX_TIMEOUT_S)
		throw new CommandError(`${command}: invalid timeout: ${value} (0 to ${MAX_TIMEOUT_S} seconds)`);
	return seconds;
}

/** `-S`: the first line, `-N` for N lines of scrollback, `-` for all of it; 0 or none for the screen only. */
function parseStart(command: string, value: string | undefined): number {
	if (value === undefined) return 0;
	if (value === "-") return ALL_SCROLLBACK;
	if (!/^-?\d+$/.test(value)) throw new CommandError(`${command}: invalid start line: ${value}`);
	return Math.min(ALL_SCROLLBACK, Math.max(0, -Number(value)));
}
