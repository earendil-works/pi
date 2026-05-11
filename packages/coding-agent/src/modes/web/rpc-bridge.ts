import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { Broadcast, WebRpcCommand, WebRpcResponse } from "./types.js";

interface PendingRpc {
	command: string;
	resolve: (value: WebRpcResponse) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

export class RpcBridge {
	private child: ChildProcessWithoutNullStreams;
	private pending = new Map<string, PendingRpc>();
	private nextId = 1;
	private stdoutBuffer = "";
	private stderrBuffer = "";

	constructor(
		private readonly cliPath: string,
		private readonly rpcArgs: string[],
		private readonly broadcast: Broadcast,
		public readonly cwd: string,
		private readonly extraEnv: NodeJS.ProcessEnv = {},
	) {
		this.child = this.spawnRpc();
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	send<T extends WebRpcResponse = WebRpcResponse>(command: WebRpcCommand, timeoutMs = 30000): Promise<T> {
		const id = `web-${this.nextId++}`;
		const message = { ...command, id };
		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC command timed out: ${command.type}`));
			}, timeoutMs);
			this.pending.set(id, {
				command: command.type,
				resolve: (value) => resolve(value as T),
				reject,
				timeout,
			});
			this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
				if (!error) return;
				clearTimeout(timeout);
				this.pending.delete(id);
				reject(error);
			});
		});
	}

	sendDetached(command: WebRpcCommand): Promise<WebRpcResponse> {
		const id = `web-${this.nextId++}`;
		const message = { ...command, id };
		return new Promise((resolve, reject) => {
			this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
				if (error) reject(error);
				else resolve({ type: "response", id, command: command.type, success: true } as WebRpcResponse);
			});
		});
	}

	stop(signal: NodeJS.Signals = "SIGTERM"): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timeout);
			pending.reject(new Error(`RPC exited before ${pending.command} completed`));
			this.pending.delete(id);
		}
		if (!this.child.killed) this.child.kill(signal);
	}

	private spawnRpc(): ChildProcessWithoutNullStreams {
		const child = spawn(process.execPath, [this.cliPath, "--mode", "rpc", ...this.rpcArgs], {
			cwd: this.cwd,
			env: { ...process.env, ...this.extraEnv },
			stdio: ["pipe", "pipe", "pipe"],
		});

		child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
		child.stderr.on("data", (chunk: Buffer) => this.handleStderr(chunk));
		child.on("exit", (code, signal) => {
			this.broadcast({ type: "rpc_exit", code, signal });
			for (const [id, pending] of this.pending) {
				clearTimeout(pending.timeout);
				pending.reject(new Error(`RPC exited code=${code} signal=${signal}`));
				this.pending.delete(id);
			}
		});
		child.on("error", (error) => {
			this.broadcast({ type: "rpc_error", error: error.message });
		});
		return child;
	}

	private handleStdout(chunk: Buffer): void {
		this.stdoutBuffer += chunk.toString("utf8");
		this.consumeLines("stdout");
	}

	private handleStderr(chunk: Buffer): void {
		this.stderrBuffer += chunk.toString("utf8");
		let index = this.stderrBuffer.indexOf("\n");
		while (index >= 0) {
			const line = this.stderrBuffer.slice(0, index).replace(/\r$/, "");
			this.stderrBuffer = this.stderrBuffer.slice(index + 1);
			if (line.trim()) this.broadcast({ type: "rpc_stderr", line });
			index = this.stderrBuffer.indexOf("\n");
		}
	}

	private consumeLines(_stream: "stdout"): void {
		let index = this.stdoutBuffer.indexOf("\n");
		while (index >= 0) {
			const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, "");
			this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
			this.handleLine(line);
			index = this.stdoutBuffer.indexOf("\n");
		}
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let message: WebRpcResponse | Record<string, unknown>;
		try {
			message = JSON.parse(line) as WebRpcResponse | Record<string, unknown>;
		} catch {
			this.broadcast({ type: "rpc_parse_error", line });
			return;
		}
		if (message.type === "response" && typeof message.id === "string") {
			const pending = this.pending.get(message.id);
			if (pending) {
				clearTimeout(pending.timeout);
				this.pending.delete(message.id);
				pending.resolve(message as WebRpcResponse);
			}
		}
		this.broadcast(message);
	}
}
