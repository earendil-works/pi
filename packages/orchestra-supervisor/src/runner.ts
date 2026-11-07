// Runner abstraction: production uses Pi RPC processes; tests use in-memory Agent.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@earendil-works/pi-agent-core";

export interface SpawnSpec {
	name: string;
	role: string;
	cwd: string;
	sessionFile: string;
	sessionDir: string;
	extensionPath: string;
	model?: string;
	extraEnv?: Record<string, string>;
	agentId: string;
	supervisorUrl: string;
}

export interface AgentRunner {
	readonly agentId: string;
	readonly pid: number | null;
	readonly exited: boolean;
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	abort(): Promise<void>;
	onEvent(cb: (e: AgentEvent | { type: string; [k: string]: unknown }) => void): void;
	kill(): void;
	dispose(): Promise<void>;
}

function resolvePiCli(): string {
	// Prefer built bundle (packages/coding-agent/dist/bundle/cli.js), else dist/cli.js.
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(here, "../../../../coding-agent/dist/bundle/cli.js"),
		join(here, "../../coding-agent/dist/bundle/cli.js"),
		join(here, "../../../packages/coding-agent/dist/bundle/cli.js"),
	];
	for (const c of candidates) if (existsSync(c)) return c;
	const fallback = join(process.cwd(), "packages/coding-agent/dist/bundle/cli.js");
	return existsSync(fallback) ? fallback : candidates[0]!;
}

export class RpcAgentRunner implements AgentRunner {
	readonly agentId: string;
	readonly spec: SpawnSpec;
	private proc: ChildProcessWithoutNullStreams | null = null;
	private listeners: ((e: AgentEvent | { type: string; [k: string]: unknown }) => void)[] = [];
	private buffer = "";
	private nextId = 0;
	private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

	constructor(spec: SpawnSpec) {
		this.agentId = spec.agentId;
		this.spec = spec;
	}

	get pid(): number | null {
		return this.proc?.pid ?? null;
	}
	get exited(): boolean {
		return !this.proc || this.proc.exitCode !== null || this.proc.signalCode !== null;
	}

	async start(): Promise<void> {
		if (this.proc) return;
		const cli = resolvePiCli();
		const args = [
			cli,
			"--mode",
			"rpc",
			"--session",
			this.spec.sessionFile,
			"--session-dir",
			this.spec.sessionDir,
			"-e",
			this.spec.extensionPath,
		];
		if (this.spec.model) args.push("--model", this.spec.model);
		this.proc = spawn(process.execPath, args, {
			cwd: this.spec.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				ORCHESTRA_AGENT_ID: this.spec.agentId,
				ORCHESTRA_AGENT_NAME: this.spec.name,
				ORCHESTRA_AGENT_ROLE: this.spec.role,
				ORCHESTRA_SUPERVISOR_URL: this.spec.supervisorUrl,
				ORCHESTRA_WORKTREE: this.spec.cwd,
				...(this.spec.extraEnv ?? {}),
			},
		});
		this.proc.stdout.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString("utf8");
			const lines = this.buffer.split("\n");
			this.buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const obj = JSON.parse(line) as {
						type?: string;
						id?: string;
						command?: string;
						success?: boolean;
						data?: unknown;
						error?: string;
					} & Record<string, unknown>;
					if (obj.type === "response" && obj.id && this.pending.has(obj.id)) {
						const p = this.pending.get(obj.id)!;
						this.pending.delete(obj.id);
						if (obj.success) p.resolve(obj.data ?? null);
						else p.reject(new Error(String(obj.error ?? "rpc error")));
						continue;
					}
					for (const l of this.listeners) l(obj as AgentEvent);
				} catch {
					// Ignore malformed lines (extension_ui_request handled as event).
				}
			}
		});
		this.proc.stderr.on("data", () => {});
	}

	private send(command: Record<string, unknown>): Promise<unknown> {
		if (!this.proc || !this.proc.stdin) return Promise.reject(new Error("agent not running"));
		const id = String(++this.nextId);
		const msg = JSON.stringify({ ...command, id }) + "\n";
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.proc!.stdin.write(msg, (err) => {
				if (err) {
					this.pending.delete(id);
					reject(err);
				}
			});
		});
	}

	async prompt(text: string): Promise<void> {
		await this.send({ type: "prompt", message: text });
	}
	async steer(text: string): Promise<void> {
		await this.send({ type: "steer", message: text });
	}
	async followUp(text: string): Promise<void> {
		await this.send({ type: "follow_up", message: text });
	}
	async abort(): Promise<void> {
		try {
			await this.send({ type: "abort" });
		} catch {
			/* already gone */
		}
	}
	onEvent(cb: (e: AgentEvent | { type: string; [k: string]: unknown }) => void): void {
		this.listeners.push(cb);
	}
	kill(): void {
		this.proc?.kill("SIGTERM");
	}
	async dispose(): Promise<void> {
		if (!this.proc) return;
		try {
			this.proc.stdin.end();
		} catch {
			/* noop */
		}
		this.proc.kill("SIGTERM");
		this.proc = null;
	}
}

// In-memory runner for tests (uses pi-agent-core Agent + FakeProvider StreamFn).
// Kept in supervisor pkg so tests don't need a real Pi process or API key.
import { Agent } from "@earendil-works/pi-agent-core";
import { FAKE_MODEL, FakeProvider } from "@earendil-works/pi-orchestra-core";

export class InMemoryAgentRunner implements AgentRunner {
	readonly agentId: string;
	readonly agent: Agent;
	private listeners: ((e: AgentEvent | { type: string; [k: string]: unknown }) => void)[] = [];
	private dead = false;

	constructor(
		agentId: string,
		script: { text?: string; toolCalls?: { name: string; args: Record<string, unknown> }[] }[],
	) {
		this.agentId = agentId;
		const provider = new FakeProvider(script);
		this.agent = new Agent({
			initialState: { systemPrompt: "", model: FAKE_MODEL, tools: [] as never },
			streamFn: provider.streamFn,
		});
		this.agent.subscribe(async (event) => {
			for (const l of this.listeners) l(event as AgentEvent);
			// Keep store heartbeat updated by caller via events.
		});
	}
	get pid(): number | null {
		return null;
	}
	get exited(): boolean {
		return this.dead;
	}
	async prompt(text: string): Promise<void> {
		await this.agent.prompt(text);
	}
	async steer(text: string): Promise<void> {
		this.agent.steer({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	}
	async followUp(text: string): Promise<void> {
		this.agent.followUp({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	}
	async abort(): Promise<void> {
		this.agent.abort();
	}
	onEvent(cb: (e: AgentEvent | { type: string; [k: string]: unknown }) => void): void {
		this.listeners.push(cb);
	}
	kill(): void {
		this.dead = true;
		this.agent.abort();
	}
	async dispose(): Promise<void> {
		this.kill();
	}
}
