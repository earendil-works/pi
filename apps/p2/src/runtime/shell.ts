// User shell commands (`!cmd`, `!!cmd`; p2-tui-port.md section 10.8) as Durable entries (browser-safe). A finished
// command is placed as a `p2.shell` entry through a write submission: it never starts a run. With `includeInContext`
// (`!`) the entry also carries a user model message, pi's `bashExecutionToText`, so the agent sees it on its next run;
// `!!` entries are display-only. The data never has a `text` field, so readers never take it for a person's message.

import { bool, compile, num, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { AuthorSchema } from "./input.ts";

/** Entry kind of a finished user shell command. */
export const SHELL_ENTRY = "p2.shell";

/** The output a command keeps: the tail within the bash tool's limits (Durable's DEFAULT_MAX_LINES/BYTES). */
export const SHELL_MAX_LINES = 2000;
export const SHELL_MAX_BYTES = 50 * 1024;

export const ShellDataSchema = obj(
	{
		author: AuthorSchema,
		command: str(),
		/** The retained tail of stdout and stderr, as they arrived. */
		output: str(),
		/** Absent when the command did not end by itself (cancelled, failed to start, timed out). */
		exitCode: opt(num()),
		cancelled: bool(),
		/** Earlier output was dropped from `output`. */
		truncated: bool(),
		/** Where the environment kept the complete output, when it spilled (a path on the machine the command ran on). */
		fullOutputPath: opt(str()),
		/** `!` (true) or `!!` (false). */
		includeInContext: bool(),
		/** Why it did not run or finish, e.g. a start failure. */
		error: opt(str()),
	},
	{ open: true },
);
export type ShellData = Static<typeof ShellDataSchema>;

const isShellData = compile(ShellDataSchema).check;

export const shellData = (data: unknown): ShellData | undefined => (isShellData(data) ? data : undefined);

/** pi's `bashExecutionToText` (coding-agent core/messages.ts): what the model reads for an included command. */
export function shellContextText(data: ShellData): string {
	let text = `Ran \`${data.command}\`\n`;
	text += data.output ? `\`\`\`\n${data.output}\n\`\`\`` : "(no output)";
	if (data.cancelled) text += "\n\n(command cancelled)";
	else if (data.error) text += `\n\n${data.error}`;
	else if (data.exitCode !== undefined && data.exitCode !== 0) text += `\n\nCommand exited with code ${data.exitCode}`;
	if (data.truncated && data.fullOutputPath) text += `\n\n[Output truncated. Full output: ${data.fullOutputPath}]`;
	return text;
}

/**
 * The tail of `text` within the limits: whole lines from the end, at most `maxLines` lines and `maxBytes` UTF-8 bytes
 * (a single longer line keeps its end). `truncated` says whether anything was dropped.
 */
export function shellTail(
	text: string,
	maxLines = SHELL_MAX_LINES,
	maxBytes = SHELL_MAX_BYTES,
): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	let truncated = false;
	if (lines.length > maxLines) {
		lines.splice(0, lines.length - maxLines);
		truncated = true;
	}
	let kept = lines.join("\n");
	const encoder = new TextEncoder();
	if (encoder.encode(kept).length > maxBytes) {
		truncated = true;
		let bytes = 0;
		let start = lines.length;
		while (start > 0) {
			const size = encoder.encode(lines[start - 1]!).length + (start < lines.length ? 1 : 0);
			if (bytes + size > maxBytes) break;
			bytes += size;
			start--;
		}
		kept = lines.slice(start).join("\n");
		// One line longer than the limit: its end.
		if (start === lines.length) {
			const last = lines.at(-1) ?? "";
			let cut = Math.max(0, last.length - maxBytes);
			while (encoder.encode(last.slice(cut)).length > maxBytes) cut++;
			kept = last.slice(cut);
		}
	}
	return { text: kept, truncated };
}
