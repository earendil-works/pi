// Sole-writer SQLite store (node:sqlite). All reads/writes go through this.
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./schema.ts";
import type {
	AgentRecord,
	BudgetSlice,
	CheckRecord,
	CheckRunRecord,
	DeliveryRecord,
	DeliveryState,
	LeaseRecord,
	MessageRecord,
	MessageType,
	TaskRecord,
} from "./types.ts";
import { emptyBudget } from "./types.ts";
import { ulid } from "./ulid.ts";

export interface StoreOptions {
	path: string;
}

function rowToAgent(r: Record<string, unknown>): AgentRecord {
	return {
		id: String(r.id),
		name: String(r.name),
		role: String(r.role),
		parentId: r.parent_id == null ? null : String(r.parent_id),
		depth: Number(r.depth),
		taskId: r.task_id == null ? null : String(r.task_id),
		state: String(r.state) as AgentRecord["state"],
		worktreePath: r.worktree_path == null ? null : String(r.worktree_path),
		branch: r.branch == null ? null : String(r.branch),
		pid: r.pid == null ? null : Number(r.pid),
		port: r.port == null ? null : Number(r.port),
		model: r.model == null ? null : String(r.model),
		sessionFile: r.session_file == null ? null : String(r.session_file),
		lastEventAt: r.last_event_at == null ? null : Number(r.last_event_at),
		createdAt: Number(r.created_at),
	};
}

function globToRegex(glob: string): RegExp {
	// Support ** and * only.
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const re = escaped
		.replace(/\*\*/g, "\u0000")
		.replace(/\*/g, "[^/]*")
		.replace(/\u0000/g, ".*");
	return new RegExp(`^${re}$`);
}

export function matchGlob(filePath: string, globs: string[]): boolean {
	return globs.some((g) => globToRegex(g).test(filePath));
}

export class Store {
	readonly db: DatabaseSync;

	constructor(options: StoreOptions) {
		this.db = new DatabaseSync(options.path);
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;`);
		this.migrate();
	}

	private migrate(): void {
		this.db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`);
		const row = this.db.prepare(`SELECT version FROM schema_version ORDER BY version DESC LIMIT 1`).get() as
			| { version: number }
			| undefined;
		const current = row?.version ?? 0;
		for (const m of MIGRATIONS) {
			if (m.version <= current) continue;
			this.db.exec(m.sql);
			this.db.prepare(`INSERT OR REPLACE INTO schema_version(version) VALUES (?)`).run(m.version);
		}
	}

	close(): void {
		this.db.close();
	}

	// --- agents ---
	createAgent(input: {
		id?: string;
		name: string;
		role: string;
		parentId?: string | null;
		depth?: number;
		taskId?: string | null;
		model?: string | null;
		worktreePath?: string | null;
		branch?: string | null;
		port?: number | null;
		sessionFile?: string | null;
	}): AgentRecord {
		const now = Date.now();
		const id = input.id ?? ulid(now);
		this.db
			.prepare(
				`INSERT INTO agents(id,name,role,parent_id,depth,task_id,state,worktree_path,branch,port,model,session_file,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			)
			.run(
				id,
				input.name,
				input.role,
				input.parentId ?? null,
				input.depth ?? 0,
				input.taskId ?? null,
				"spawning",
				input.worktreePath ?? null,
				input.branch ?? null,
				input.port ?? null,
				input.model ?? null,
				input.sessionFile ?? null,
				now,
			);
		return this.getAgent(id)!;
	}

	getAgent(id: string): AgentRecord | undefined {
		const r = this.db.prepare(`SELECT * FROM agents WHERE id=?`).get(id) as Record<string, unknown> | undefined;
		return r ? rowToAgent(r) : undefined;
	}

	getAgentByName(name: string): AgentRecord | undefined {
		const r = this.db.prepare(`SELECT * FROM agents WHERE name=?`).get(name) as Record<string, unknown> | undefined;
		return r ? rowToAgent(r) : undefined;
	}

	listAgents(): AgentRecord[] {
		const rows = this.db.prepare(`SELECT * FROM agents ORDER BY created_at`).all() as Record<string, unknown>[];
		return rows.map(rowToAgent);
	}

	setAgentState(id: string, state: AgentRecord["state"]): void {
		this.db.prepare(`UPDATE agents SET state=? WHERE id=?`).run(state, id);
	}
	setAgentPid(id: string, pid: number | null): void {
		this.db.prepare(`UPDATE agents SET pid=? WHERE id=?`).run(pid, id);
	}
	setAgentHeartbeat(id: string, at: number = Date.now()): void {
		this.db.prepare(`UPDATE agents SET last_event_at=? WHERE id=?`).run(at, id);
	}
	setAgentShell(
		id: string,
		shell: { worktreePath?: string; branch?: string; port?: number; sessionFile?: string },
	): void {
		this.db
			.prepare(
				`UPDATE agents SET worktree_path=COALESCE(?,worktree_path), branch=COALESCE(?,branch), port=COALESCE(?,port), session_file=COALESCE(?,session_file) WHERE id=?`,
			)
			.run(shell.worktreePath ?? null, shell.branch ?? null, shell.port ?? null, shell.sessionFile ?? null, id);
	}

	// --- tasks ---
	createTask(input: {
		id?: string;
		title: string;
		spec: string;
		ownerAgentId?: string | null;
		parentTaskId?: string | null;
		ownsGlobs?: string[];
	}): TaskRecord {
		const now = Date.now();
		const id = input.id ?? ulid(now);
		this.db
			.prepare(
				`INSERT INTO tasks(id,title,spec,owner_agent_id,state,parent_task_id,owns_globs,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
			)
			.run(
				id,
				input.title,
				input.spec,
				input.ownerAgentId ?? null,
				"pending",
				input.parentTaskId ?? null,
				JSON.stringify(input.ownsGlobs ?? []),
				0,
				now,
				now,
			);
		return this.getTask(id)!;
	}
	getTask(id: string): TaskRecord | undefined {
		const r = this.db.prepare(`SELECT * FROM tasks WHERE id=?`).get(id) as Record<string, unknown> | undefined;
		if (!r) return undefined;
		return {
			id: String(r.id),
			title: String(r.title),
			spec: String(r.spec ?? ""),
			ownerAgentId: r.owner_agent_id == null ? null : String(r.owner_agent_id),
			state: String(r.state) as TaskRecord["state"],
			parentTaskId: r.parent_task_id == null ? null : String(r.parent_task_id),
			ownsGlobs: JSON.parse(String(r.owns_globs ?? "[]")) as string[],
			attempts: Number(r.attempts ?? 0),
			createdAt: Number(r.created_at),
			updatedAt: Number(r.updated_at),
		};
	}
	listTasks(): TaskRecord[] {
		const rows = this.db.prepare(`SELECT * FROM tasks ORDER BY created_at`).all() as Record<string, unknown>[];
		return rows.map((r) => this.getTask(String(r.id))!).filter(Boolean);
	}
	setTaskState(id: string, state: TaskRecord["state"]): void {
		this.db.prepare(`UPDATE tasks SET state=?, updated_at=? WHERE id=?`).run(state, Date.now(), id);
	}
	setTaskOwner(id: string, ownerAgentId: string | null): void {
		this.db.prepare(`UPDATE tasks SET owner_agent_id=?, updated_at=? WHERE id=?`).run(ownerAgentId, Date.now(), id);
	}
	bumpTaskAttempts(id: string): number {
		const t = this.getTask(id)!;
		this.db.prepare(`UPDATE tasks SET attempts=?, updated_at=? WHERE id=?`).run(t.attempts + 1, Date.now(), id);
		return t.attempts + 1;
	}
	addDep(taskId: string, dependsOn: string): void {
		this.db.prepare(`INSERT OR IGNORE INTO task_deps(task_id,depends_on) VALUES(?,?)`).run(taskId, dependsOn);
	}
	taskDeps(taskId: string): string[] {
		const rows = this.db.prepare(`SELECT depends_on FROM task_deps WHERE task_id=?`).all(taskId) as {
			depends_on: string;
		}[];
		return rows.map((r) => r.depends_on);
	}
	readyTasks(): TaskRecord[] {
		// ready = pending and all deps done
		const pending = this.db.prepare(`SELECT * FROM tasks WHERE state='pending' ORDER BY created_at`).all() as Record<
			string,
			unknown
		>[];
		const out: TaskRecord[] = [];
		for (const r of pending) {
			const t = this.getTask(String(r.id))!;
			const deps = this.taskDeps(t.id);
			if (deps.every((d) => this.getTask(d)?.state === "done")) out.push(t);
		}
		return out;
	}

	// --- checks ---
	addCheck(input: {
		id?: string;
		taskId: string;
		kind: CheckRecord["kind"];
		config: Record<string, unknown>;
		required?: boolean;
	}): CheckRecord {
		const id = input.id ?? ulid();
		this.db
			.prepare(`INSERT INTO checks(id,task_id,kind,config,required) VALUES(?,?,?,?,?)`)
			.run(id, input.taskId, input.kind, JSON.stringify(input.config), input.required === false ? 0 : 1);
		return { id, taskId: input.taskId, kind: input.kind, config: input.config, required: input.required !== false };
	}
	listChecks(taskId: string): CheckRecord[] {
		const rows = this.db.prepare(`SELECT * FROM checks WHERE task_id=? ORDER BY id`).all(taskId) as Record<
			string,
			unknown
		>[];
		return rows.map((r) => ({
			id: String(r.id),
			taskId: String(r.task_id),
			kind: String(r.kind) as CheckRecord["kind"],
			config: JSON.parse(String(r.config ?? "{}")) as Record<string, unknown>,
			required: Number(r.required) === 1,
		}));
	}
	addCheckRun(input: {
		checkId: string;
		attempt: number;
		passed: boolean;
		signature: string;
		outputPath?: string | null;
	}): CheckRunRecord {
		const id = ulid();
		this.db
			.prepare(
				`INSERT INTO check_runs(id,check_id,attempt,passed,signature,output_path,ran_at) VALUES(?,?,?,?,?,?,?)`,
			)
			.run(
				id,
				input.checkId,
				input.attempt,
				input.passed ? 1 : 0,
				input.signature,
				input.outputPath ?? null,
				Date.now(),
			);
		return {
			id,
			checkId: input.checkId,
			attempt: input.attempt,
			passed: input.passed,
			signature: input.signature,
			outputPath: input.outputPath ?? null,
			ranAt: Date.now(),
		};
	}
	lastRuns(checkId: string, limit: number): CheckRunRecord[] {
		const rows = this.db
			.prepare(`SELECT * FROM check_runs WHERE check_id=? ORDER BY ran_at DESC LIMIT ?`)
			.all(checkId, limit) as Record<string, unknown>[];
		return rows.map((r) => ({
			id: String(r.id),
			checkId: String(r.check_id),
			attempt: Number(r.attempt),
			passed: Number(r.passed) === 1,
			signature: String(r.signature),
			outputPath: r.output_path == null ? null : String(r.output_path),
			ranAt: Number(r.ran_at),
		}));
	}

	// --- leases ---
	acquireLease(
		path: string,
		agentId: string,
		taskId: string | null,
		ttlMs = 30_000,
	): { ok: true } | { ok: false; owner: AgentRecord } {
		const now = Date.now();
		const existing = this.db.prepare(`SELECT * FROM leases WHERE path=?`).get(path) as
			| Record<string, unknown>
			| undefined;
		if (existing && Number(existing.expires_at) > now && String(existing.agent_id) !== agentId) {
			return { ok: false, owner: this.getAgent(String(existing.agent_id))! };
		}
		this.db
			.prepare(`INSERT OR REPLACE INTO leases(path,agent_id,task_id,expires_at,mode) VALUES(?,?,?,?,?)`)
			.run(path, agentId, taskId, now + ttlMs, "write");
		return { ok: true };
	}
	// Guard: may agentId edit filePath? Respects task owns_globs + existing leases.
	canEdit(agentId: string, filePath: string): { allowed: boolean; owner?: AgentRecord; reason: string } {
		const agent = this.getAgent(agentId);
		if (!agent) return { allowed: false, reason: `unknown agent ${agentId}` };
		const now = Date.now();
		const lease = this.db.prepare(`SELECT * FROM leases WHERE path=?`).get(filePath) as
			| Record<string, unknown>
			| undefined;
		if (lease && Number(lease.expires_at) > now) {
			if (String(lease.agent_id) === agentId) return { allowed: true, reason: "owns lease" };
			const owner = this.getAgent(String(lease.agent_id))!;
			return { allowed: false, owner, reason: `leased by ${owner.name}` };
		}
		// Expired lease → reclaim and allow if task owns it or path free.
		if (lease) this.db.prepare(`DELETE FROM leases WHERE path=?`).run(filePath);
		if (agent.taskId) {
			const task = this.getTask(agent.taskId);
			if (task) {
				if (task.ownsGlobs.length > 0) {
					if (matchGlob(filePath, task.ownsGlobs)) {
						this.acquireLease(filePath, agentId, agent.taskId);
						return { allowed: true, reason: "task owns_globs" };
					}
					return { allowed: false, reason: `not in task owns_globs [${task.ownsGlobs.join(",")}]` };
				}
				// No globs → free path, grant lease.
				this.acquireLease(filePath, agentId, agent.taskId);
				return { allowed: true, reason: "free path" };
			}
		}
		this.acquireLease(filePath, agentId, agent.taskId);
		return { allowed: true, reason: "free path" };
	}
	releaseLeasesForAgent(agentId: string): void {
		this.db.prepare(`DELETE FROM leases WHERE agent_id=?`).run(agentId);
	}
	listLeases(): LeaseRecord[] {
		const rows = this.db.prepare(`SELECT * FROM leases ORDER BY path`).all() as Record<string, unknown>[];
		return rows.map((r) => ({
			path: String(r.path),
			agentId: String(r.agent_id),
			taskId: r.task_id == null ? null : String(r.task_id),
			expiresAt: Number(r.expires_at),
			mode: String(r.mode ?? "write"),
		}));
	}

	// --- messages ---
	sendMessage(input: {
		id?: string;
		threadId?: string | null;
		fromAgentId: string;
		toAgentId?: string | null;
		toRole?: string | null;
		broadcast?: boolean;
		type: MessageType;
		body: string;
		inReplyTo?: string | null;
	}): MessageRecord {
		const now = Date.now();
		const id = input.id ?? ulid(now);
		this.db
			.prepare(
				`INSERT INTO messages(id,thread_id,from_agent_id,to_agent_id,to_role,broadcast,type,body,in_reply_to,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
			)
			.run(
				id,
				input.threadId ?? null,
				input.fromAgentId,
				input.toAgentId ?? null,
				input.toRole ?? null,
				input.broadcast ? 1 : 0,
				input.type,
				input.body,
				input.inReplyTo ?? null,
				now,
			);
		// Create deliveries for recipients (deduped by message id).
		const recipients = new Set<string>();
		if (input.toAgentId) recipients.add(input.toAgentId);
		if (input.broadcast) {
			for (const a of this.listAgents()) if (a.id !== input.fromAgentId) recipients.add(a.id);
		}
		if (input.toRole) {
			for (const a of this.listAgents())
				if (a.role === input.toRole && a.id !== input.fromAgentId) recipients.add(a.id);
		}
		if (input.toAgentId == null && !input.broadcast && !input.toRole) {
			// Supervisor broadcast default: all live agents.
			for (const a of this.listAgents()) if (a.id !== input.fromAgentId) recipients.add(a.id);
		}
		for (const r of recipients) {
			this.db
				.prepare(`INSERT OR IGNORE INTO deliveries(message_id,recipient,state,attempts) VALUES(?,?, 'queued', 0)`)
				.run(id, r);
		}
		return {
			id,
			threadId: input.threadId ?? null,
			fromAgentId: input.fromAgentId,
			toAgentId: input.toAgentId ?? null,
			toRole: input.toRole ?? null,
			broadcast: !!input.broadcast,
			type: input.type,
			body: input.body,
			inReplyTo: input.inReplyTo ?? null,
			createdAt: now,
		};
	}
	inbox(agentId: string): { message: MessageRecord; delivery: DeliveryRecord }[] {
		const rows = this.db
			.prepare(
				`SELECT m.*, d.state AS d_state, d.attempts AS d_attempts, d.delivered_at AS d_delivered FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE d.recipient=? AND d.state!='acked' ORDER BY m.created_at`,
			)
			.all(agentId) as Record<string, unknown>[];
		return rows.map((r) => ({
			message: {
				id: String(r.id),
				threadId: r.thread_id == null ? null : String(r.thread_id),
				fromAgentId: String(r.from_agent_id),
				toAgentId: r.to_agent_id == null ? null : String(r.to_agent_id),
				toRole: r.to_role == null ? null : String(r.to_role),
				broadcast: Number(r.broadcast) === 1,
				type: String(r.type) as MessageType,
				body: String(r.body),
				inReplyTo: r.in_reply_to == null ? null : String(r.in_reply_to),
				createdAt: Number(r.created_at),
			},
			delivery: {
				messageId: String(r.id),
				recipient: agentId,
				state: String(r.d_state) as DeliveryState,
				attempts: Number(r.d_attempts),
				deliveredAt: r.d_delivered == null ? null : Number(r.d_delivered),
			},
		}));
	}
	markDelivered(messageId: string, recipient: string): void {
		this.db
			.prepare(
				`UPDATE deliveries SET state='delivered', delivered_at=?, attempts=attempts+1 WHERE message_id=? AND recipient=? AND state='queued'`,
			)
			.run(Date.now(), messageId, recipient);
	}
	ack(messageId: string, recipient: string): void {
		// Idempotent: acking twice is a no-op.
		this.db
			.prepare(`UPDATE deliveries SET state='acked' WHERE message_id=? AND recipient=?`)
			.run(messageId, recipient);
	}
	pendingDeliveries(): { message: MessageRecord; delivery: DeliveryRecord }[] {
		const rows = this.db
			.prepare(
				`SELECT m.*, d.recipient AS d_recipient, d.state AS d_state, d.attempts AS d_attempts FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE d.state='queued' ORDER BY m.created_at`,
			)
			.all() as Record<string, unknown>[];
		return rows.map((r) => ({
			message: {
				id: String(r.id),
				threadId: r.thread_id == null ? null : String(r.thread_id),
				fromAgentId: String(r.from_agent_id),
				toAgentId: r.to_agent_id == null ? null : String(r.to_agent_id),
				toRole: r.to_role == null ? null : String(r.to_role),
				broadcast: Number(r.broadcast) === 1,
				type: String(r.type) as MessageType,
				body: String(r.body),
				inReplyTo: r.in_reply_to == null ? null : String(r.in_reply_to),
				createdAt: Number(r.created_at),
			},
			delivery: {
				messageId: String(r.id),
				recipient: String(r.d_recipient),
				state: String(r.d_state) as DeliveryState,
				attempts: Number(r.d_attempts),
				deliveredAt: null,
			},
		}));
	}

	// --- events ---
	addEvent(agentId: string, kind: string, payload: Record<string, unknown>): void {
		this.db
			.prepare(`INSERT INTO events(agent_id,ts,kind,payload) VALUES(?,?,?,?)`)
			.run(agentId, Date.now(), kind, JSON.stringify(payload));
		this.setAgentHeartbeat(agentId);
	}
	recentEvents(agentId: string, limit: number): { ts: number; kind: string; payload: Record<string, unknown> }[] {
		const rows = this.db
			.prepare(`SELECT ts,kind,payload FROM events WHERE agent_id=? ORDER BY id DESC LIMIT ?`)
			.all(agentId, limit) as Record<string, unknown>[];
		return rows.map((r) => ({
			ts: Number(r.ts),
			kind: String(r.kind),
			payload: JSON.parse(String(r.payload ?? "{}")) as Record<string, unknown>,
		}));
	}

	// --- budgets ---
	setBudget(scope: string, scopeId: string, slice: BudgetSlice): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO budgets(scope,scope_id,max_turns,max_tokens,max_wall_clock_ms,max_depth,max_children,used_turns,used_tokens,used_ms) VALUES(?,?,?,?,?,?,?,?,?,?)`,
			)
			.run(
				scope,
				scopeId,
				slice.maxTurns,
				slice.maxTokens,
				slice.maxWallClockMs,
				slice.maxDepth,
				slice.maxChildren,
				slice.usedTurns,
				slice.usedTokens,
				slice.usedMs,
			);
	}
	getBudget(scope: string, scopeId: string): BudgetSlice | undefined {
		const r = this.db.prepare(`SELECT * FROM budgets WHERE scope=? AND scope_id=?`).get(scope, scopeId) as
			| Record<string, unknown>
			| undefined;
		if (!r) return undefined;
		return emptyBudget({
			maxTurns: Number(r.max_turns),
			maxTokens: Number(r.max_tokens),
			maxWallClockMs: Number(r.max_wall_clock_ms),
			maxDepth: Number(r.max_depth),
			maxChildren: Number(r.max_children),
			usedTurns: Number(r.used_turns),
			usedTokens: Number(r.used_tokens),
			usedMs: Number(r.used_ms),
		});
	}
	addBudgetUsage(
		scope: string,
		scopeId: string,
		delta: { turns?: number; tokens?: number; ms?: number },
	): BudgetSlice {
		const cur = this.getBudget(scope, scopeId) ?? emptyBudget();
		const next = emptyBudget({
			...cur,
			usedTurns: cur.usedTurns + (delta.turns ?? 0),
			usedTokens: cur.usedTokens + (delta.tokens ?? 0),
			usedMs: cur.usedMs + (delta.ms ?? 0),
		});
		this.setBudget(scope, scopeId, next);
		return next;
	}

	// --- decisions / escalations ---
	logDecision(input: {
		trigger: string;
		inputRef?: string | null;
		decision: string;
		rationale: string;
		by: "reconciler" | "proxy" | "human";
	}): string {
		const id = ulid();
		this.db
			.prepare(`INSERT INTO decisions(id,ts,trigger,input_ref,decision,rationale,by) VALUES(?,?,?,?,?,?,?)`)
			.run(id, Date.now(), input.trigger, input.inputRef ?? null, input.decision, input.rationale, input.by);
		return id;
	}
	addEscalation(input: { id?: string; agentId?: string | null; reason: string }): string {
		const id = input.id ?? ulid();
		this.db
			.prepare(`INSERT INTO escalations(id,ts,agent_id,reason,state) VALUES(?,?,?,?, 'open')`)
			.run(id, Date.now(), input.agentId ?? null, input.reason);
		this.logDecision({
			trigger: "escalation",
			inputRef: id,
			decision: "escalate",
			rationale: input.reason,
			by: "reconciler",
		});
		return id;
	}
	listEscalations(): {
		id: string;
		ts: number;
		agentId: string | null;
		reason: string;
		state: string;
		humanReply: string | null;
	}[] {
		const rows = this.db.prepare(`SELECT * FROM escalations ORDER BY ts`).all() as Record<string, unknown>[];
		return rows.map((r) => ({
			id: String(r.id),
			ts: Number(r.ts),
			agentId: r.agent_id == null ? null : String(r.agent_id),
			reason: String(r.reason),
			state: String(r.state),
			humanReply: r.human_reply == null ? null : String(r.human_reply),
		}));
	}

	countAgentsByState(): Record<string, number> {
		const rows = this.db.prepare(`SELECT state, COUNT(*) AS n FROM agents GROUP BY state`).all() as {
			state: string;
			n: number;
		}[];
		const out: Record<string, number> = {};
		for (const r of rows) out[r.state] = Number(r.n);
		return out;
	}
}
