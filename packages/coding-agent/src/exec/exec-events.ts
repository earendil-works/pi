export type ExecThreadStartedEvent = {
	type: "thread.started";
	thread_id: string;
};

export type ExecTurnStartedEvent = {
	type: "turn.started";
};

export type ExecTurnCompletedEvent = {
	type: "turn.completed";
};

export type ExecTurnFailedEvent = {
	type: "turn.failed";
	error: string;
};

export type ExecErrorEvent = {
	type: "error";
	error: string;
};

export type ExecAgentMessageItem = {
	id: string;
	type: "agent_message";
	text: string;
};

export type ExecCommandExecutionItem = {
	id: string;
	type: "command_execution";
	command: string;
	status: "in_progress" | "completed" | "failed";
	output?: string;
	exit_code?: number;
};

export type ExecFileChangeItem = {
	id: string;
	type: "file_change";
	paths: string[];
	change_kind: string;
	status: "in_progress" | "completed" | "failed";
};

export type ExecTodoListSummary = {
	total: number;
	pending: number;
	in_progress: number;
	completed: number;
	blocked: number;
};

export type ExecTodoListEntry = {
	id: string;
	content: string;
	status: string;
	priority: string;
};

export type ExecTodoListItem = {
	id: string;
	type: "todo_list";
	status: "in_progress" | "completed" | "failed";
	summary: ExecTodoListSummary;
	items: ExecTodoListEntry[];
};

export type ExecToolCallItem = {
	id: string;
	type: "tool_call";
	tool_name: string;
	status?: "in_progress" | "completed" | "failed";
	arguments?: Record<string, unknown>;
	output?: string;
	result?: unknown;
};

export type ExecItem =
	| ExecAgentMessageItem
	| ExecCommandExecutionItem
	| ExecFileChangeItem
	| ExecTodoListItem
	| ExecToolCallItem;

export type ExecItemStartedEvent = {
	type: "item.started";
	item: ExecItem;
};

export type ExecItemUpdatedEvent = {
	type: "item.updated";
	item: ExecItem;
};

export type ExecItemCompletedEvent = {
	type: "item.completed";
	item: ExecItem;
};

export type ExecEvent =
	| ExecThreadStartedEvent
	| ExecTurnStartedEvent
	| ExecItemStartedEvent
	| ExecItemUpdatedEvent
	| ExecItemCompletedEvent
	| ExecTurnCompletedEvent
	| ExecTurnFailedEvent
	| ExecErrorEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasValidItemShape(item: unknown): item is ExecItem {
	if (!isRecord(item) || typeof item.id !== "string" || typeof item.type !== "string") {
		return false;
	}

	if (item.type === "agent_message") {
		return typeof item.text === "string";
	}

	if (item.type === "command_execution") {
		return typeof item.command === "string" && typeof item.status === "string";
	}

	if (item.type === "file_change") {
		return Array.isArray(item.paths) && typeof item.change_kind === "string" && typeof item.status === "string";
	}

	if (item.type === "todo_list") {
		return Array.isArray(item.items) && isRecord(item.summary) && typeof item.status === "string";
	}

	if (item.type === "tool_call") {
		return typeof item.tool_name === "string";
	}

	return false;
}

export function isExecEvent(value: unknown): value is ExecEvent {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}

	switch (value.type) {
		case "thread.started":
			return typeof value.thread_id === "string";
		case "turn.started":
		case "turn.completed":
			return true;
		case "turn.failed":
		case "error":
			return typeof value.error === "string";
		case "item.started":
		case "item.updated":
		case "item.completed":
			return hasValidItemShape(value.item);
		default:
			return false;
	}
}
