/**
 * Program Resume Protocol (OSC 7577): a program tells the terminal which command brings it back after the
 * terminal restarts. Reports are authenticated with a token the terminal puts in the environment, so output
 * that merely passes through the terminal (`cat`, logs, `ssh`) cannot register commands.
 *
 * Spec: https://www.superlogical.com/rex/docs/build/program-resume
 */

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

/** The command a terminal runs to resume a program. */
export interface ProgramResumeCommand {
	/** Program and arguments. The program is a bare command name looked up on PATH, or an absolute path. */
	argv: readonly string[];
	/** Absolute working directory to resume in. */
	cwd?: string;
}

/** Who sends a report. `time` is in seconds since the Unix epoch; terminals ignore reports far from their clock. */
export interface ProgramResumeSender {
	token: string;
	pid: number;
	time: number;
}

/** Environment variable through which the terminal hands its token to the first process. */
const PROGRAM_RESUME_TOKEN_ENV = "OSC7577_TOKEN";

/**
 * Remove the token from `env` and return it. A program that reports must not pass the token on: a child that
 * kept it could replace the parent's command or, if it runs with fewer rights, register one that later runs
 * with the user's full rights.
 */
export function takeProgramResumeToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const token = env[PROGRAM_RESUME_TOKEN_ENV];
	delete env[PROGRAM_RESUME_TOKEN_ENV];
	return token || undefined;
}

/** Limits every terminal accepts. Longer reports may be ignored, which would leave an older command in place. */
const MAX_SEQUENCE_BYTES = 2048;
const MAX_ARGV_ELEMENTS = 64;

/**
 * Encode a report of `command`. Returns undefined when the protocol cannot carry the command (control
 * characters, a relative program or cwd, or over the limits); the caller then sends
 * {@link formatProgramResumeClear} so the terminal does not resume an older command in its place.
 */
export function formatProgramResume(command: ProgramResumeCommand, sender: ProgramResumeSender): string | undefined {
	if (!isReportableCommand(command)) return undefined;
	const pairs = [`argv=${command.argv.map(encodeText).join(",")}`];
	if (command.cwd !== undefined) pairs.push(`cwd=${encodeText(command.cwd)}`);
	const sequence = formatReport(pairs, sender);
	return Buffer.byteLength(sequence, "utf8") <= MAX_SEQUENCE_BYTES ? sequence : undefined;
}

/** Encode a report that removes the sender's command, for example when the user quits the program. */
export function formatProgramResumeClear(sender: ProgramResumeSender): string {
	return formatReport(["clear=1"], sender);
}

function formatReport(pairs: string[], sender: ProgramResumeSender): string {
	const body = [`pid=${sender.pid}`, `time=${sender.time}`, ...pairs].join(":");
	// Plain SHA-256 with the token last, not an HMAC: the spec chose it so shell scripts can report with sha256sum.
	const mac = createHash("sha256").update(`${body}:${sender.token}`, "utf8").digest("hex");
	return `\x1b]7577;${body}:mac=${mac}\x1b\\`;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

function isReportableText(text: string): boolean {
	// Lone surrogates have no UTF-8 encoding; Buffer would silently replace them and change the argument.
	return text.isWellFormed() && !CONTROL_CHARACTER.test(text);
}

function isReportableCommand(command: ProgramResumeCommand): boolean {
	const [program] = command.argv;
	if (program === undefined || command.argv.length > MAX_ARGV_ELEMENTS) return false;
	const isBareName = program.length > 0 && !program.startsWith("-") && !/[\\/]/.test(program);
	if (!isBareName && !isAbsolute(program)) return false;
	if (command.cwd !== undefined && !(isAbsolute(command.cwd) && isReportableText(command.cwd))) return false;
	return command.argv.every(isReportableText);
}

function encodeText(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}
