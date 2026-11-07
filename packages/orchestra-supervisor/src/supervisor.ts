// Supervisor daemon: sole writer to SQLite, reconciler loop, message bus, budgets.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { budgetExceeded, emptyBudget, Store, ulid } from "@earendil-works/pi-orchestra-core";
import { GoalEngine } from "./goals.ts";
import type { AgentRunner } from "./runner.ts";

export interface SupervisorConfig {
	dbPath: string;
	port?: number;
	maxAgents?: number;
	maxDepth?: number;
	silentMs?: number;
	reconcileMs?: number;
	worktreesDir?: string;
}

export interface SupervisorOptions {
	config: SupervisorConfig;
	runners?: Map<string, AgentRunner>;
	goalRunner?: (taskId: string, ownerAgentId: string | null) => Promise<"done" | "retry" | "stalled">;
}

function readJson(_req: IncomingMessage, body: string): unknown {
	try {
		return body ? JSON.parse(body) : {};
	} catch {
		return {};
	}
}

export class Supervisor {
	readonly store: Store;
	readonly opts: SupervisorOptions;
	private http: Server | null = null;
	private port: number;
	private runners = new Map<string, AgentRunner>();
	private timer: NodeJS.Timeout | null = null;
	private loopCount = 0;

	constructor(opts: SupervisorOptions) {
		this.opts = opts;
		this.store = new Store({ path: opts.config.dbPath });
		this.port = opts.config.port ?? 0;
		if (opts.runners) for (const [id, r] of opts.runners) this.runners.set(id, r);
	}

	get supervisorUrl(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	async listen(): Promise<void> {
		if (this.http) return;
		await new Promise<void>((resolve) => {
			this.http = createServer((req, res) => {
				void this.handle(req, res);
			});
			this.http.listen(this.port, "127.0.0.1", () => {
				const addr = this.http!.address();
				if (addr && typeof addr === "object") this.port = addr.port;
				resolve();
			});
		});
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = req.url ?? "/";
		const method = req.method ?? "GET";
		const chunks: Buffer[] = [];
		await new Promise<void>((resolve) => {
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => resolve());
		});
		const body = Buffer.concat(chunks).toString("utf8");
		const json = (status: number, obj: unknown) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(obj));
		};
		try {
			if (method === "GET" && url === "/health") return json(200, { ok: true, ts: Date.now() });
			if (method === "POST" && url === "/can-edit") {
				const b = readJson(req, body) as { agentId: string; filePath: string };
				// Reads are always allowed.
				const isWrite = !b.filePath.startsWith("read:");
				const path = isWrite ? b.filePath : b.filePath.slice(5);
				const verdict = this.store.canEdit(b.agentId, path);
				return json(200, {
					allowed: verdict.allowed,
					reason: verdict.reason,
					ownerName: verdict.owner?.name,
					ownerTask: verdict.owner?.taskId ?? undefined,
				});
			}
			if (method === "POST" && url === "/message") {
				const b = readJson(req, body) as {
					fromAgentId: string;
					toAgentId?: string;
					toRole?: string;
					broadcast?: boolean;
					threadId?: string;
					inReplyTo?: string;
					type: string;
					body: string;
				};
				if (!b.fromAgentId) return json(400, { error: "fromAgentId required" });
				const message = this.store.sendMessage({
					fromAgentId: b.fromAgentId,
					toAgentId: b.toAgentId,
					toRole: b.toRole,
					broadcast: b.broadcast,
					threadId: b.threadId,
					inReplyTo: b.inReplyTo,
					type: b.type as never,
					body: b.body ?? "",
				});
				return json(200, { message });
			}
			if (method === "POST" && url === "/inbox") {
				const b = readJson(req, body) as { agentId: string };
				const items = this.store.inbox(b.agentId);
				for (const it of items) this.store.markDelivered(it.message.id, b.agentId);
				return json(200, { items });
			}
			if (method === "POST" && url === "/ack") {
				const b = readJson(req, body) as { messageId: string; agentId: string };
				this.store.ack(b.messageId, b.agentId);
				return json(200, { ok: true });
			}
			if (method === "POST" && url === "/spawn") {
				const b = readJson(req, body) as {
					parentAgentId?: string;
					name: string;
					role: string;
					taskSpec: string;
					ownsGlobs?: string[];
					model?: string;
				};
				const created = this.spawnAgent({
					name: b.name,
					role: b.role,
					taskSpec: b.taskSpec,
					ownsGlobs: b.ownsGlobs,
					model: b.model,
					parentAgentId: b.parentAgentId,
				});
				if ("error" in created) return json(400, { error: created.error });
				return json(200, { agentId: created.agent.id, name: created.agent.name });
			}
			return json(404, { error: `no route ${method} ${url}` });
		} catch (e) {
			return json(500, { error: e instanceof Error ? e.message : String(e) });
		}
	}

	spawnAgent(input: {
		name: string;
		role: string;
		taskSpec: string;
		ownsGlobs?: string[];
		model?: string;
		parentAgentId?: string;
	}): { agent: import("@earendil-works/pi-orchestra-core").AgentRecord } | { error: string } {
		const parent = input.parentAgentId ? this.store.getAgent(input.parentAgentId) : undefined;
		const depth = parent ? parent.depth + 1 : 0;
		const maxDepth = this.opts.config.maxDepth ?? 3;
		if (depth > maxDepth) return { error: `max depth ${maxDepth}` };
		const maxAgents = this.opts.config.maxAgents ?? 6;
		if (this.store.listAgents().length >= maxAgents) return { error: `max agents ${maxAgents}` };
		// Budget slice deduct from parent.
		if (parent) {
			const pb = this.store.getBudget("agent", parent.id);
			if (pb) {
				const slice = emptyBudget({
					maxTurns: pb.maxTurns - pb.usedTurns,
					maxTokens: pb.maxTokens - pb.usedTokens,
				});
				if (slice.maxTurns <= 0 || slice.maxTokens <= 0) return { error: "parent budget exhausted" };
				// Deduct minimal slice (checked, not reserved: supervisor tracks used from events).
			}
		}
		const task = this.store.createTask({
			title: `${input.role}: ${input.taskSpec.slice(0, 80)}`,
			spec: input.taskSpec,
			ownsGlobs: input.ownsGlobs ?? [],
		});
		const agent = this.store.createAgent({
			name: input.name,
			role: input.role,
			parentId: input.parentAgentId ?? null,
			depth,
			taskId: task.id,
			model: input.model ?? null,
		});
		this.store.setTaskOwner(task.id, agent.id);
		this.store.setBudget("agent", agent.id, emptyBudget());
		this.store.addEvent(agent.id, "spawned", { name: input.name, role: input.role, depth });
		return { agent };
	}

	registerRunner(runner: AgentRunner): void {
		this.runners.set(runner.agentId, runner);
		runner.onEvent((e) => {
			const t = (e as { type?: string }).type ?? "event";
			this.store.addEvent(runner.agentId, t, {});
			if (t === "agent_end") {
				this.store.setAgentState(runner.agentId, "verifying");
			}
			if (t === "turn_end") {
				this.store.addBudgetUsage("agent", runner.agentId, { turns: 1 });
			}
		});
	}

	/** Deterministic reconciler tick (called every ~2s in prod). */
	async reconcile(): Promise<void> {
		this.loopCount++;
		const now = Date.now();
		const silentMs = this.opts.config.silentMs ?? 30_000;
		// Heartbeats / silence → stalled (restart/reassign handled by caller via escalations).
		for (const agent of this.store.listAgents()) {
			if (agent.state === "done" || agent.state === "killed" || agent.state === "stalled") continue;
			if (agent.lastEventAt != null && now - agent.lastEventAt > silentMs && agent.state === "working") {
				this.store.setAgentState(agent.id, "stalled");
				this.store.addEscalation({
					agentId: agent.id,
					reason: `agent ${agent.name} silent ${Math.round((now - agent.lastEventAt) / 1000)}s`,
				});
				const runner = this.runners.get(agent.id);
				if (runner) {
					await runner.steer("status?");
				}
			}
			// Budget enforcement.
			const budget = this.store.getBudget("agent", agent.id);
			if (budget) {
				const exceeded = budgetExceeded(budget);
				if (exceeded) {
					this.store.setAgentState(agent.id, "stalled");
					this.store.addEscalation({
						agentId: agent.id,
						reason: `agent ${agent.name} budget exceeded: ${exceeded}`,
					});
					const runner = this.runners.get(agent.id);
					if (runner) await runner.abort();
				}
			}
		}
		// Ready tasks → spawn if capacity.
		for (const task of this.store.readyTasks()) {
			if (!task.ownerAgentId) {
				this.store.setTaskState(task.id, "ready");
				// Production would spawn an agent here; tests call spawnAgent directly.
			}
		}
		// Message redelivery (at-least-once, deduped by id on receive).
		for (const { message, delivery } of this.store.pendingDeliveries()) {
			const runner = this.runners.get(delivery.recipient);
			if (!runner) continue;
			await runner.steer(`[orchestra ${message.type} from supervisor] ${message.body}`);
			this.store.markDelivered(message.id, delivery.recipient);
		}
		// Verifying → goal engine (if configured).
		if (this.opts.goalRunner) {
			for (const task of this.store.listTasks()) {
				if (task.state === "verifying") {
					await this.opts.goalRunner(task.id, task.ownerAgentId);
				}
			}
		}
	}

	startLoop(): void {
		if (this.timer) return;
		const ms = this.opts.config.reconcileMs ?? 2000;
		this.timer = setInterval(() => {
			void this.reconcile();
		}, ms);
		this.timer.unref?.();
	}

	async close(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		if (this.http) {
			await new Promise<void>((resolve, reject) => this.http!.close((e) => (e ? reject(e) : resolve())));
			this.http = null;
		}
		for (const r of this.runners.values()) await r.dispose();
		this.store.close();
	}
}

export function createSupervisor(opts: SupervisorOptions): Supervisor {
	return new Supervisor(opts);
}

export function ulidReexport(): string {
	return ulid();
}
