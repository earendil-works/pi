import type { Context } from "@earendil-works/chord";
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
import {
	type AnyTask,
	type CompactionResult,
	type Conversation,
	defineExtension,
	defineTask,
	type Extension,
	type Harness,
	type HookApi,
	type HooksOf,
	hook,
	type SettledTask,
	type SubmissionDraft,
	type TaskRuntime,
} from "../src/index.ts";

declare const callContext: Context;

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

it("types submissions, task waits, compaction, and tasks erased into extensions", () => {
	const input = { type: "input", content: "hi", whenBusy: "steer" } satisfies SubmissionDraft;
	const write = { type: "write", entry: { kind: "note" } } satisfies SubmissionDraft;
	expectTypeOf(input.type).toEqualTypeOf<"input">();
	expectTypeOf(write.type).toEqualTypeOf<"write">();

	// A task with narrowed input, several phases, and custom hooks.
	type Hooks = {
		beforeStep(step: number, api: HookApi, context: Context): { readonly skip: boolean } | undefined;
	};
	type Checkpoint = { phase: "plan"; steps: number } | { phase: "run"; step: number };
	const Stepper = defineTask<{ steps: number }, Checkpoint, { ran: number }, Hooks>({
		name: "test.stepper",
		version: 1,
		initial: (input) => ({ phase: "plan", steps: input.steps }),
		phases: {
			plan: async (task, runtime, context) => {
				expectTypeOf(task.state.checkpoint.steps).toEqualTypeOf<number>();
				expectTypeOf(task.input.steps).toEqualTypeOf<number>();
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "run", step: 0 } }), context);
			},
			run: async (task, runtime, context) => {
				expectTypeOf(task.state.checkpoint.step).toEqualTypeOf<number>();
				await runtime.hooks.each("beforeStep", (handler) => {
					expectTypeOf(handler).toEqualTypeOf<Hooks["beforeStep"]>();
				});
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: { ran: 1 } } }),
					context,
				);
			},
		},
		abort: async () => {},
	});
	expectTypeOf<HooksOf<typeof Stepper>>().toEqualTypeOf<Hooks>();
	const registration = hook(Stepper, { beforeStep: (step) => (step > 1 ? { skip: true } : undefined) });
	// Erased into an extension, whatever its input, phases, and hooks.
	const erased: AnyTask = Stepper;
	const extension: Extension = defineExtension({ name: "stepper", tasks: [Stepper], hooks: [registration] });
	void [erased, extension];

	const typedWaits = async (
		harness: Harness,
		conversation: Conversation,
		runtime: TaskRuntime<null, Checkpoint, null, Hooks>,
	) => {
		const id = await conversation.commit(
			(tx) => tx.createTask(Stepper, { steps: 2 }, { ownership: { kind: "conversation" } }),
			callContext,
		);
		expectTypeOf(id).toEqualTypeOf<TaskId<{ ran: number }>>();
		const settled = await harness.waitForTask(id, callContext);
		expectTypeOf(settled).toEqualTypeOf<SettledTask<{ ran: number }>>();
		if (settled.state.outcome.status === "completed") {
			expectTypeOf(settled.state.outcome.result).toEqualTypeOf<{ ran: number }>();
		}
		expectTypeOf(await runtime.waitForTask(id, callContext)).toEqualTypeOf<SettledTask<{ ran: number }>>();
		const compaction = await conversation.compact(undefined, callContext);
		expectTypeOf(compaction).toEqualTypeOf<TaskId<CompactionResult>>();
		expectTypeOf(await harness.waitForTask(compaction, callContext)).toEqualTypeOf<SettledTask<CompactionResult>>();
	};
	expectTypeOf(typedWaits).toBeFunction();

	const compileTimeFailures = (conversation: Conversation) => {
		// @ts-expect-error an input submission carries no entry
		const inputWithEntry: SubmissionDraft = { type: "input", content: "hi", entry: { kind: "note" } };
		// @ts-expect-error a write submission carries no content
		const writeWithContent: SubmissionDraft = { type: "write", entry: { kind: "note" }, content: "hi" };
		// @ts-expect-error a write submission never generates, so it has no busy policy
		const writeWhenBusy: SubmissionDraft = { type: "write", entry: { kind: "note" }, whenBusy: "steer" };
		// @ts-expect-error hook handlers are typed by the task's hooks
		const wrongHook = hook(Stepper, { beforeStep: (_step: string) => undefined });
		// @ts-expect-error hook names come from the task's hooks
		const unknownHook = hook(Stepper, { afterStep: () => undefined });
		const wrongInput = conversation.commit(
			// @ts-expect-error task input is typed by the definition
			(tx) => tx.createTask(Stepper, { steps: "two" }, { ownership: { kind: "conversation" } }),
			callContext,
		);
		const missingPhase = defineTask<null, Checkpoint, null>({
			name: "test.missing-phase",
			version: 1,
			initial: () => ({ phase: "plan", steps: 1 }),
			// @ts-expect-error the phase map is exhaustive
			phases: { plan: async () => {} },
			abort: async () => {},
		});
		void [inputWithEntry, writeWithContent, writeWhenBusy, wrongHook, unknownHook, wrongInput, missingPhase];
	};
	expectTypeOf(compileTimeFailures).toBeFunction();
});
