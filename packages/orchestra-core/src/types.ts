// Orchestra shared types: agents, tasks, leases, messages, checks, budgets.

export type AgentState =
	| "spawning"
	| "idle"
	| "working"
	| "waiting_msg"
	| "verifying"
	| "done"
	| "failed"
	| "stalled"
	| "killed";

export type TaskState = "pending" | "ready" | "in_progress" | "verifying" | "done" | "failed" | "blocked" | "escalated";

export type MessageType = "handoff" | "blocked" | "question" | "answer" | "info" | "done";

export type DeliveryState = "queued" | "delivered" | "acked";

export interface AgentRecord {
	id: string;
	name: string;
	role: string;
	parentId: string | null;
	depth: number;
	taskId: string | null;
	state: AgentState;
	worktreePath: string | null;
	branch: string | null;
	pid: number | null;
	port: number | null;
	model: string | null;
	sessionFile: string | null;
	lastEventAt: number | null;
	createdAt: number;
}

export interface TaskRecord {
	id: string;
	title: string;
	spec: string;
	ownerAgentId: string | null;
	state: TaskState;
	parentTaskId: string | null;
	ownsGlobs: string[];
	attempts: number;
	createdAt: number;
	updatedAt: number;
}

export interface CheckRecord {
	id: string;
	taskId: string;
	kind: "cmd" | "screenshot_diff" | "dom_assert";
	config: Record<string, unknown>;
	required: boolean;
}

export interface CheckRunRecord {
	id: string;
	checkId: string;
	attempt: number;
	passed: boolean;
	signature: string;
	outputPath: string | null;
	ranAt: number;
}

export interface LeaseRecord {
	path: string;
	agentId: string;
	taskId: string | null;
	expiresAt: number;
	mode: string;
}

export interface MessageRecord {
	id: string;
	threadId: string | null;
	fromAgentId: string;
	toAgentId: string | null;
	toRole: string | null;
	broadcast: boolean;
	type: MessageType;
	body: string;
	inReplyTo: string | null;
	createdAt: number;
}

export interface DeliveryRecord {
	messageId: string;
	recipient: string;
	state: DeliveryState;
	attempts: number;
	deliveredAt: number | null;
}

export interface BudgetSlice {
	maxTurns: number;
	maxTokens: number;
	maxWallClockMs: number;
	maxDepth: number;
	maxChildren: number;
	usedTurns: number;
	usedTokens: number;
	usedMs: number;
}

export function emptyBudget(partial: Partial<BudgetSlice> = {}): BudgetSlice {
	return {
		maxTurns: partial.maxTurns ?? 50,
		maxTokens: partial.maxTokens ?? 500_000,
		maxWallClockMs: partial.maxWallClockMs ?? 600_000,
		maxDepth: partial.maxDepth ?? 3,
		maxChildren: partial.maxChildren ?? 4,
		usedTurns: partial.usedTurns ?? 0,
		usedTokens: partial.usedTokens ?? 0,
		usedMs: partial.usedMs ?? 0,
	};
}

export function budgetExceeded(b: BudgetSlice): string | null {
	if (b.usedTurns >= b.maxTurns) return `turns ${b.usedTurns}/${b.maxTurns}`;
	if (b.usedTokens >= b.maxTokens) return `tokens ${b.usedTokens}/${b.maxTokens}`;
	if (b.usedMs >= b.maxWallClockMs) return `wall-clock ${b.usedMs}/${b.maxWallClockMs}ms`;
	return null;
}
