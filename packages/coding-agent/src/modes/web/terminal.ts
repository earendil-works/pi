import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { Broadcast, TerminalState } from "./types.js";
import { TERMINAL_REPLAY_BYTES } from "./types.js";

type IPty = {
	pid: number;
	process: string;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: string): void;
	onData(callback: (data: string) => void): { dispose(): void };
	onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
};

type NodePtyModule = {
	spawn(
		file: string,
		args: string[],
		options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number },
	): IPty;
};

export interface TerminalManagerOptions {
	broadcast: Broadcast;
	loadPty?: () => NodePtyModule | null;
}

interface TerminalSession {
	cwd: string;
	pty: IPty;
	buffer: string;
	running: boolean;
	exitCode: number | null;
	signal: number | string | null;
	cols: number;
	rows: number;
	disposables: Array<{ dispose(): void }>;
}

const require = createRequire(import.meta.url);

export function loadNodePty(): NodePtyModule | null {
	for (const moduleName of ["@lydell/node-pty", "node-pty"]) {
		try {
			return require(moduleName) as NodePtyModule;
		} catch {}
	}
	return null;
}

export class TerminalUnavailableError extends Error {
	constructor() {
		super("Terminal unavailable: optional dependency node-pty is not installed or failed to load");
	}
}

export class TerminalManager {
	private sessions = new Map<string, TerminalSession>();
	private readonly loadPty: () => NodePtyModule | null;

	constructor(private readonly options: TerminalManagerOptions) {
		this.loadPty = options.loadPty ?? loadNodePty;
	}

	start(cwd: string, cols = 100, rows = 30): TerminalState {
		const existing = this.sessions.get(this.key(cwd));
		if (existing?.running) return this.state(cwd);
		const nodePty = this.loadPty();
		if (!nodePty) throw new TerminalUnavailableError();

		const resolvedCwd = this.key(cwd);
		const shell = this.shell();
		const pty = this.spawnTerminal(nodePty, shell.file, shell.args, resolvedCwd, cols, rows);
		const terminal: TerminalSession = {
			cwd: resolvedCwd,
			pty,
			buffer: "",
			running: true,
			exitCode: null,
			signal: null,
			cols,
			rows,
			disposables: [],
		};
		terminal.disposables.push(
			terminal.pty.onData((data) => {
				terminal.buffer = this.appendBuffer(terminal.buffer, data);
				this.options.broadcast({ type: "terminal_output", cwd: terminal.cwd, data });
			}),
			terminal.pty.onExit((event) => {
				terminal.running = false;
				terminal.exitCode = event.exitCode;
				terminal.signal = event.signal ?? null;
				this.options.broadcast({
					type: "terminal_exit",
					cwd: terminal.cwd,
					code: event.exitCode,
					signal: event.signal ?? null,
				});
			}),
		);
		terminal.pty.write("\r");
		this.sessions.set(resolvedCwd, terminal);
		this.options.broadcast({ type: "terminal_start", cwd: resolvedCwd, pid: terminal.pty.pid });
		return this.state(resolvedCwd);
	}

	write(cwd: string, data: string): TerminalState {
		const terminal = this.sessions.get(this.key(cwd));
		if (!terminal?.running) throw new Error("Terminal is not running");
		terminal.pty.write(data);
		return this.toState(terminal);
	}

	resize(cwd: string, cols: number, rows: number): TerminalState {
		const terminal = this.sessions.get(this.key(cwd));
		if (!terminal?.running) throw new Error("Terminal is not running");
		terminal.cols = sanitizeSize(cols, 100);
		terminal.rows = sanitizeSize(rows, 30);
		terminal.pty.resize(terminal.cols, terminal.rows);
		return this.toState(terminal);
	}

	stop(cwd: string): TerminalState {
		const key = this.key(cwd);
		const terminal = this.sessions.get(key);
		if (!terminal) return this.state(key);
		for (const disposable of terminal.disposables) disposable.dispose();
		if (terminal.running) terminal.pty.kill();
		terminal.running = false;
		this.sessions.delete(key);
		return this.toState(terminal);
	}

	stopAll(): void {
		for (const cwd of this.sessions.keys()) this.stop(cwd);
	}

	state(cwd: string): TerminalState {
		const resolvedCwd = this.key(cwd);
		const terminal = this.sessions.get(resolvedCwd);
		if (!terminal) {
			return {
				cwd: resolvedCwd,
				running: false,
				pid: null,
				buffer: "",
				exitCode: null,
				signal: null,
				cols: 100,
				rows: 30,
			};
		}
		return this.toState(terminal);
	}

	private key(cwd: string): string {
		return path.resolve(cwd || process.cwd());
	}

	private toState(terminal: TerminalSession): TerminalState {
		return {
			cwd: terminal.cwd,
			running: terminal.running,
			pid: terminal.pty.pid,
			buffer: terminal.buffer,
			exitCode: terminal.exitCode,
			signal: terminal.signal,
			cols: terminal.cols,
			rows: terminal.rows,
		};
	}

	private shell(): { file: string; args: string[] } {
		if (process.platform === "win32") return { file: process.env.COMSPEC || "cmd.exe", args: [] };
		const shell = process.env.SHELL || (os.platform() === "darwin" ? "/bin/zsh" : "/bin/sh");
		const base = path.basename(shell);
		const args = base === "bash" || base === "zsh" || base === "fish" || base === "sh" ? ["-i"] : [];
		return { file: shell, args };
	}

	private spawnTerminal(
		nodePty: NodePtyModule,
		file: string,
		args: string[],
		cwd: string,
		cols: number,
		rows: number,
	): IPty {
		try {
			return nodePty.spawn(file, args, {
				cwd,
				env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
				cols,
				rows,
			});
		} catch {
			return createChildProcessPty(file, cwd);
		}
	}

	private appendBuffer(buffer: string, data: string): string {
		const next = buffer + data;
		return next.length > TERMINAL_REPLAY_BYTES ? next.slice(-TERMINAL_REPLAY_BYTES) : next;
	}
}

function createChildProcessPty(file: string, cwd: string): IPty {
	const child = spawn(file, [], {
		cwd,
		env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	return {
		pid: child.pid ?? 0,
		process: file,
		write: (data: string) => {
			child.stdin.write(data.replace(/\r/g, "\n"));
		},
		resize: () => {},
		kill: (signal?: string) => {
			child.kill(signal as NodeJS.Signals | undefined);
		},
		onData: (callback: (data: string) => void) => {
			const stdoutHandler = (chunk: Buffer) => callback(chunk.toString("utf8"));
			const stderrHandler = (chunk: Buffer) => callback(chunk.toString("utf8"));
			child.stdout.on("data", stdoutHandler);
			child.stderr.on("data", stderrHandler);
			return {
				dispose: () => {
					child.stdout.off("data", stdoutHandler);
					child.stderr.off("data", stderrHandler);
				},
			};
		},
		onExit: (callback: (event: { exitCode: number; signal?: number }) => void) => {
			const exitHandler = (exitCode: number | null) => callback({ exitCode: exitCode ?? 0 });
			child.on("exit", exitHandler);
			return { dispose: () => child.off("exit", exitHandler) };
		},
	};
}

function sanitizeSize(value: number, fallback: number): number {
	if (!Number.isInteger(value) || value < 2 || value > 500) return fallback;
	return value;
}
