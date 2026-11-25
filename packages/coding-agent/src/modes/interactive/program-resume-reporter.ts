import {
	formatProgramResume,
	formatProgramResumeClear,
	type ProgramResumeCommand,
	type Terminal,
} from "@earendil-works/pi-tui";

/**
 * Tells the terminal how to resume the current session after the terminal restarts (OSC 7577). Only created
 * when the terminal supplied a token. The terminal holds one command per process; it is replaced when the
 * command changes (new, resumed or forked session, first message written) and cleared when the session has
 * no file to resume or the user quits. Ending pi through the terminal (SIGHUP, SIGTERM) keeps it, because
 * that is when the terminal needs it.
 */
export class ProgramResumeReporter {
	private readonly token: string;
	private readonly getTerminal: () => Terminal;
	private readonly getResumeCommand: () => ProgramResumeCommand | undefined;
	/** The command the terminal holds for this process, as JSON. Undefined when it holds none. */
	private reported: string | undefined;

	constructor(token: string, getTerminal: () => Terminal, getResumeCommand: () => ProgramResumeCommand | undefined) {
		this.token = token;
		this.getTerminal = getTerminal;
		this.getResumeCommand = getResumeCommand;
	}

	/** Report the current command if it changed since the last report. */
	report(): void {
		const command = this.getResumeCommand();
		if ((command && JSON.stringify(command)) !== this.reported) this.send(command);
	}

	/**
	 * Report the current command even if unchanged. A program that ran while pi was suspended may have replaced
	 * pi's command in a terminal that keeps only the latest one.
	 */
	reportAgain(): void {
		const command = this.getResumeCommand();
		if (command || this.reported !== undefined) this.send(command);
	}

	/** Remove the command because the user quit. */
	clear(): void {
		if (this.reported !== undefined) this.send(undefined);
	}

	private send(command: ProgramResumeCommand | undefined): void {
		const sender = { token: this.token, pid: process.pid, time: Math.floor(Date.now() / 1000) };
		// A command the protocol cannot carry is cleared, so the terminal does not resume an older one in its place.
		const sequence = (command && formatProgramResume(command, sender)) ?? formatProgramResumeClear(sender);
		this.reported = command && JSON.stringify(command);
		this.getTerminal().write(sequence);
	}
}
