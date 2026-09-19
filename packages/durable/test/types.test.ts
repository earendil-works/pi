import { expectTypeOf, it } from "vitest";
import type {
	ContextEdit,
	DocumentCreate,
	DocumentRecord,
	Input,
	TaskOutcome,
	TaskRecord,
	TaskState,
} from "../src/index.ts";

it("encodes discriminator-dependent fields", () => {
	const omit = { target: 1, action: "omit" } satisfies ContextEdit;
	const replace = { target: 1, action: "replace", messages: [] } satisfies ContextEdit;
	const pending = { status: "pending", checkpoint: { phase: "ready" } } satisfies TaskState<
		{ phase: string },
		{ value: number }
	>;
	const terminal = {
		status: "terminal",
		outcome: { status: "completed", result: { value: 1 } },
	} satisfies TaskState<{ phase: string }, { value: number }>;
	const conversationDocument = {
		id: 1,
		kind: "test",
		scope: { kind: "conversation", conversationId: 1 },
		history: "rewindable",
		fork: "asOf",
	} satisfies DocumentCreate;

	expectTypeOf(omit.action).toEqualTypeOf<"omit">();
	expectTypeOf(replace.action).toEqualTypeOf<"replace">();
	expectTypeOf(pending.status).toEqualTypeOf<"pending">();
	expectTypeOf(terminal.status).toEqualTypeOf<"terminal">();
	expectTypeOf(conversationDocument.fork).toEqualTypeOf<"asOf">();

	const compileTimeFailures = () => {
		// @ts-expect-error replacement edits require replacement messages
		const missingReplacement: ContextEdit = { target: 1, action: "replace" };
		// @ts-expect-error omission edits cannot carry replacement messages
		const omissionWithMessages: ContextEdit = { target: 1, action: "omit", messages: [] };
		const pendingWithOutcome: TaskState<{ phase: string }, number> = {
			status: "pending",
			checkpoint: { phase: "ready" },
			// @ts-expect-error live task state cannot carry a terminal outcome
			outcome: { status: "completed", result: 1 },
		};
		// @ts-expect-error terminal task state cannot retain a live checkpoint
		const terminalWithCheckpoint: TaskState<{ phase: string }, number> = {
			status: "terminal",
			checkpoint: { phase: "ready" },
			outcome: { status: "completed", result: 1 },
		};
		// @ts-expect-error terminal task records cannot retain live memos
		const terminalWithMemos: TaskRecord<null, { phase: string }, number> = {
			id: 1,
			conversationId: 1,
			kind: "test",
			version: 1,
			input: null,
			state: { status: "terminal", outcome: { status: "completed", result: 1 } },
			after: [],
			background: false,
			abortRequested: false,
			memos: { retained: true },
		};
		// @ts-expect-error session documents do not declare conversation history behavior
		const sessionWithHistory: DocumentRecord = {
			id: 1,
			kind: "test",
			createdAt: 1,
			scope: { kind: "session" },
			history: "latest",
			fork: "current",
		};
		// @ts-expect-error conversation document creation requires history and fork policies
		const conversationWithoutPolicy: DocumentCreate = {
			id: 1,
			kind: "test",
			scope: { kind: "conversation", conversationId: 1 },
		};
		// @ts-expect-error session document creation cannot declare conversation policies
		const sessionCreateWithPolicy: DocumentCreate = {
			id: 1,
			kind: "test",
			scope: { kind: "session" },
			history: "latest",
			fork: "current",
		};
		const taskWithPolicy = {
			id: 1,
			kind: "test",
			scope: { kind: "task", taskId: 1 },
			history: "latest",
			fork: "initial",
		} as const;
		// @ts-expect-error task document creation cannot declare conversation policies
		const taskCreateWithPolicy: DocumentCreate = taskWithPolicy;
		// @ts-expect-error latest document creation cannot use as-of fork behavior
		const latestCreateWithAsOf: DocumentCreate = {
			id: 1,
			kind: "test",
			scope: { kind: "conversation", conversationId: 1 },
			history: "latest",
			fork: "asOf",
		};
		const createWithSequence: DocumentCreate = {
			id: 1,
			kind: "test",
			scope: { kind: "session" },
			// @ts-expect-error storage, not the create command, supplies createdAt
			createdAt: 1,
		};
		// @ts-expect-error completed outcomes cannot carry errors
		const completedWithError: TaskOutcome<number> = {
			status: "completed",
			result: 1,
			error: { message: "impossible" },
		};
		// @ts-expect-error queued inputs cannot reference transcript entries
		const queuedWithEntry: Input = { id: 1, conversationId: 1, status: "queued", entry: 2 };
		void [
			missingReplacement,
			omissionWithMessages,
			pendingWithOutcome,
			terminalWithCheckpoint,
			terminalWithMemos,
			sessionWithHistory,
			conversationWithoutPolicy,
			sessionCreateWithPolicy,
			taskCreateWithPolicy,
			latestCreateWithAsOf,
			createWithSequence,
			completedWithError,
			queuedWithEntry,
		];
	};

	expectTypeOf(compileTimeFailures).toBeFunction();
});
