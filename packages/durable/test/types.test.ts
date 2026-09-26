import { expect, expectTypeOf, it } from "vitest";
import { idFromNumber, seqFromNumber } from "../src/ids.ts";
import type {
	ContextEdit,
	ConversationId,
	DocumentContent,
	DocumentCreate,
	DocumentId,
	DocumentRecord,
	EntryId,
	StorageWrite,
	SubmissionCreate,
	SubmissionId,
	SubmissionRecord,
	TaskId,
	TaskOutcome,
	TaskRecord,
	TaskState,
} from "../src/index.ts";

const conversationId = idFromNumber<ConversationId>(1);
const entryId = idFromNumber<EntryId>(2);
const answerId = idFromNumber<EntryId>(3);
const taskId = idFromNumber<TaskId<number>>(4);
const submissionId = idFromNumber<SubmissionId>(5);
const documentId = idFromNumber<DocumentId>(6);
const seq = seqFromNumber(1);

type TaskResult<I> = I extends TaskId<infer R> ? R : never;

it("brands numeric IDs by record kind and carries task result types", () => {
	expect(typeof conversationId).toBe("number");
	expect(JSON.stringify(taskId)).toBe("4");
	expectTypeOf(conversationId).toMatchTypeOf<number>();
	expectTypeOf<TaskResult<typeof taskId>>().toEqualTypeOf<number>();

	const compileTimeFailures = () => {
		const widenedTask: TaskId = idFromNumber<TaskId<{ ok: boolean }>>(7);
		// @ts-expect-error an erased task result cannot be narrowed without a typed source
		const narrowedTask: TaskId<string> = widenedTask;
		// @ts-expect-error conversation IDs are not task IDs
		const wrongTask: TaskId = conversationId;
		// @ts-expect-error task IDs are not conversation IDs
		const wrongConversation: ConversationId = taskId;
		// @ts-expect-error entry IDs are not document IDs
		const wrongDocument: DocumentId = entryId;
		// @ts-expect-error entity IDs are not commit sequences
		const wrongSequence: typeof seq = entryId;
		void [narrowedTask, wrongTask, wrongConversation, wrongDocument, wrongSequence];
	};
	expectTypeOf(compileTimeFailures).toBeFunction();
});

it("encodes discriminator-dependent fields", () => {
	const omit = { target: entryId, action: "omit" } satisfies ContextEdit;
	const replace = { target: entryId, action: "replace", messages: [] } satisfies ContextEdit;
	const pending = { status: "pending", checkpoint: { phase: "ready" } } satisfies TaskState<
		{ phase: string },
		{ value: number }
	>;
	const terminal = {
		status: "terminal",
		outcome: { status: "completed", result: { value: 1 } },
	} satisfies TaskState<{ phase: string }, { value: number }>;
	const completedInput = {
		id: submissionId,
		conversationId,
		type: "input",
		status: "done",
		entry: entryId,
		answer: answerId,
	} satisfies SubmissionRecord;
	const completedWrite = {
		id: submissionId,
		conversationId,
		type: "write",
		status: "done",
		entry: entryId,
	} satisfies SubmissionRecord;
	const queuedWriteCreate = {
		conversationId,
		type: "write",
		status: "queued",
	} satisfies SubmissionCreate;
	const baseContent = { kind: "base", version: 1, value: { count: 1 } } satisfies DocumentContent;
	const deltaContent = { kind: "delta", version: 1, ops: [["s", ["count"], 2]] } satisfies DocumentContent;
	const conversationDocument = {
		id: documentId,
		kind: "test",
		scope: { kind: "conversation", conversationId },
		history: "rewindable",
		fork: "asOf",
	} satisfies DocumentCreate;

	expectTypeOf(omit.action).toEqualTypeOf<"omit">();
	expectTypeOf(replace.action).toEqualTypeOf<"replace">();
	expectTypeOf(pending.status).toEqualTypeOf<"pending">();
	expectTypeOf(terminal.status).toEqualTypeOf<"terminal">();
	expectTypeOf(completedInput.answer).toEqualTypeOf<EntryId>();
	expectTypeOf(completedWrite.type).toEqualTypeOf<"write">();
	expectTypeOf(queuedWriteCreate.status).toEqualTypeOf<"queued">();
	expectTypeOf(baseContent.kind).toEqualTypeOf<"base">();
	expectTypeOf(deltaContent.kind).toEqualTypeOf<"delta">();
	expectTypeOf(conversationDocument.fork).toEqualTypeOf<"asOf">();

	const compileTimeFailures = () => {
		// @ts-expect-error replacement edits require replacement messages
		const missingReplacement: ContextEdit = { target: entryId, action: "replace" };
		// @ts-expect-error omission edits cannot carry replacement messages
		const omissionWithMessages: ContextEdit = { target: entryId, action: "omit", messages: [] };
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
			id: taskId,
			conversationId,
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
			id: documentId,
			kind: "test",
			createdAt: seq,
			scope: { kind: "session" },
			history: "latest",
			fork: "current",
		};
		// @ts-expect-error conversation document creation requires history and fork policies
		const conversationWithoutPolicy: DocumentCreate = {
			id: documentId,
			kind: "test",
			scope: { kind: "conversation", conversationId },
		};
		const taskWithPolicy = {
			id: documentId,
			kind: "test",
			scope: { kind: "task", taskId },
			history: "latest",
			fork: "initial",
		} as const;
		// @ts-expect-error task document creation cannot declare conversation policies
		const taskCreateWithPolicy: DocumentCreate = taskWithPolicy;
		const createWithSequence: DocumentCreate = {
			id: documentId,
			kind: "test",
			scope: { kind: "session" },
			// @ts-expect-error storage, not the create command, supplies createdAt
			createdAt: seq,
		};
		// @ts-expect-error document bases cannot carry operation batches
		const baseWithOps: DocumentContent = { kind: "base", version: 1, value: {}, ops: [] };
		// @ts-expect-error document deltas cannot carry materialized values
		const deltaWithValue: DocumentContent = { kind: "delta", version: 1, ops: [], value: {} };
		const createWithDelta: StorageWrite = {
			type: "document.create",
			record: { id: documentId, kind: "test", scope: { kind: "session" } },
			// @ts-expect-error document creation always starts from a complete base
			content: { kind: "delta", version: 1, ops: [] },
		};
		// @ts-expect-error completed outcomes cannot carry errors
		const completedWithError: TaskOutcome<number> = {
			status: "completed",
			result: 1,
			error: { message: "impossible" },
		};
		// @ts-expect-error queued submissions cannot reference transcript entries
		const queuedWithEntry: SubmissionRecord = {
			id: submissionId,
			conversationId,
			type: "input",
			status: "queued",
			entry: entryId,
		};
		// @ts-expect-error successful input submissions require an answer entry
		const inputWithoutAnswer: SubmissionRecord = {
			id: submissionId,
			conversationId,
			type: "input",
			status: "done",
			entry: entryId,
		};
		// @ts-expect-error passive write submissions never carry an answer
		const writeWithAnswer: SubmissionRecord = {
			id: submissionId,
			conversationId,
			type: "write",
			status: "done",
			entry: entryId,
			answer: answerId,
		};
		const submissionCreateWithId: SubmissionCreate = {
			// @ts-expect-error Session, not the submission create value, assigns its ID
			id: submissionId,
			conversationId,
			type: "write",
			status: "queued",
		};
		void [
			missingReplacement,
			omissionWithMessages,
			pendingWithOutcome,
			terminalWithCheckpoint,
			terminalWithMemos,
			sessionWithHistory,
			conversationWithoutPolicy,
			taskCreateWithPolicy,
			createWithSequence,
			baseWithOps,
			deltaWithValue,
			createWithDelta,
			completedWithError,
			queuedWithEntry,
			inputWithoutAnswer,
			writeWithAnswer,
			submissionCreateWithId,
		];
	};

	expectTypeOf(compileTimeFailures).toBeFunction();
});
