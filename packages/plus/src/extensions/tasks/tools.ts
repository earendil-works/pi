/**
 * TypeBox parameter schemas for the TaskCreate/TaskUpdate/TaskList/TaskGet
 * tools (shapes adapted from openclaude's V2 task tools).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const TaskCreateParams = Type.Object({
	subject: Type.String({ description: 'Short imperative subject, e.g. "Fix auth bug"' }),
	description: Type.String({ description: "Longer description with details and acceptance criteria" }),
	activeForm: Type.Optional(
		Type.String({ description: 'Subject in active form for progress display, e.g. "Fixing auth bug"' }),
	),
	owner: Type.Optional(Type.String({ description: "Owner name (e.g. a sub-agent)" })),
});

export const TaskUpdateParams = Type.Object({
	taskId: Type.String({ description: 'Task id, e.g. "3"' }),
	subject: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	activeForm: Type.Optional(Type.String()),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description: "pending | in_progress | completed | deleted (deleted removes the task)",
		}),
	),
	addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task ids this task blocks" })),
	addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task ids blocking this task" })),
	owner: Type.Optional(Type.String()),
});

export const TaskListParams = Type.Object({});

export const TaskGetParams = Type.Object({
	taskId: Type.String({ description: 'Task id, e.g. "3"' }),
});
