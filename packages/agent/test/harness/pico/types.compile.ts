import type { Context } from "@earendil-works/chord";
import type {
	AbortClosure,
	AbortedOf,
	AbortRuntimeFor,
	BaseAbortRuntime,
	BaseTaskRuntime,
	BaseTaskTx,
	CheckpointOf,
	Entry,
	EntryInput,
	ExactJsonInput,
	FailureOf,
	InputOf,
	JsonValue,
	List,
	OutputOf,
	PayloadsOf,
	ReadonlyTaskOutput,
	ResultOf,
	RuntimeFor,
	SummaryEntry,
	TaskOf,
	TaskOutcome,
	TaskOutput,
	TaskOutputRef,
	TerminalClosure,
	TurnAbortRuntime,
	TurnOf,
	TurnTaskRuntime,
	Value,
} from "../../../src/harness/pico/index.ts";
import { defineEntry, defineList, defineTask, defineTaskOutput, defineValue } from "../../../src/harness/pico/index.ts";

type Equal<Left, Right> = (<Type>() => Type extends Left ? 1 : 2) extends <Type>() => Type extends Right ? 1 : 2
	? (<Type>() => Type extends Right ? 1 : 2) extends <Type>() => Type extends Left ? 1 : 2
		? true
		: false
	: false;
type Assert<Condition extends true> = Condition;
type HasEntry<Surface> = "entry" extends keyof Surface ? true : false;
type HasOutput<Surface> = "output" extends keyof Surface ? true : false;

type TestInput = {
	readonly prompt: string;
	readonly nested: { readonly count: number };
};
type TestCheckpoint = {
	readonly phase: "ready";
	readonly cursor: number;
};
type SameCheckpoint = {
	readonly phase: "ready";
	readonly cursor: number;
};
type IncompatibleCheckpoint = {
	readonly phase: "ready";
	readonly token: string;
};
type TestResult = { readonly answer: string };
type TestFailure = { readonly code: "failed" };
type TestAborted = { readonly cleaned: boolean };
type TestOutput = { text: string; chunks: string[] };

type JsonAssertions = [
	Assert<TestInput extends JsonValue ? true : false>,
	Assert<readonly [string, { readonly value: number }] extends JsonValue ? true : false>,
	Assert<Date extends JsonValue ? false : true>,
	Assert<{ readonly value: undefined } extends JsonValue ? false : true>,
];

const nonTurnKind = defineTask<TestInput, TestCheckpoint, TestResult, TestFailure, TestAborted>()({
	kind: "test.non_turn",
	execute() {
		return Promise.resolve(() => ({ status: "completed", result: { answer: "done" } }));
	},
	recover() {
		return Promise.resolve(() => ({ status: "failed", failure: { code: "failed" } }));
	},
	abort() {
		return Promise.resolve(() => ({ cleaned: true }));
	},
});

const turnKind = defineTask<TestInput, TestCheckpoint, TestResult, TestFailure, TestAborted>()({
	kind: "test.turn",
	turn: true,
	execute() {
		return Promise.resolve(() => ({ status: "completed", result: { answer: "done" } }));
	},
	recover() {
		return Promise.resolve(() => ({ status: "failed", failure: { code: "failed" } }));
	},
	abort() {
		return Promise.resolve(() => ({ cleaned: true }));
	},
});

const sameCheckpointKind = defineTask<TestInput, SameCheckpoint, TestResult, TestFailure, TestAborted>()({
	kind: "test.same_checkpoint",
	execute() {
		return Promise.resolve(() => ({ status: "completed", result: { answer: "done" } }));
	},
	recover() {
		return Promise.resolve(() => ({ status: "failed", failure: { code: "failed" } }));
	},
	abort() {
		return Promise.resolve(() => ({ cleaned: true }));
	},
});

const testOutputKind = defineTaskOutput<TestOutput>("test.output");
const outputTaskKind = defineTask<TestInput, TestCheckpoint, TestResult, TestFailure, TestAborted, TestOutput>()({
	kind: "test.with_output",
	output: {
		kind: testOutputKind,
		initial(input) {
			return { text: input.prompt, chunks: [] };
		},
	},
	execute() {
		return Promise.resolve(() => ({ status: "completed", result: { answer: "done" } }));
	},
	recover() {
		return Promise.resolve(() => ({ status: "failed", failure: { code: "failed" } }));
	},
	abort() {
		return Promise.resolve(() => ({ cleaned: true }));
	},
});

const incompatibleCheckpointKind = defineTask<
	TestInput,
	IncompatibleCheckpoint,
	TestResult,
	TestFailure,
	TestAborted
>()({
	kind: "test.incompatible_checkpoint",
	execute() {
		return Promise.resolve(() => ({ status: "completed", result: { answer: "done" } }));
	},
	recover() {
		return Promise.resolve(() => ({ status: "failed", failure: { code: "failed" } }));
	},
	abort() {
		return Promise.resolve(() => ({ cleaned: true }));
	},
});

type NonTurnRuntimeTx = Parameters<Parameters<RuntimeFor<TestInput, TestCheckpoint, never, false>["commit"]>[0]>[0];
type TurnRuntimeTx = Parameters<Parameters<RuntimeFor<TestInput, TestCheckpoint, never, true>["commit"]>[0]>[0];
type NonTurnAbortTx = Parameters<Parameters<AbortRuntimeFor<TestInput, TestCheckpoint, never, false>["commit"]>[0]>[0];
type TurnRuntimeAbortTx = Parameters<
	Parameters<AbortRuntimeFor<TestInput, TestCheckpoint, never, true>["commit"]>[0]
>[0];
type NonTurnFinalTx = Parameters<TerminalClosure<TestInput, TestCheckpoint, TestResult, TestFailure, never, false>>[0];
type TurnFinalTx = Parameters<TerminalClosure<TestInput, TestCheckpoint, TestResult, TestFailure, never, true>>[0];
type NonTurnAbortFinalTx = Parameters<AbortClosure<TestInput, TestCheckpoint, TestAborted, never, false>>[0];
type TurnAbortFinalTx = Parameters<AbortClosure<TestInput, TestCheckpoint, TestAborted, never, true>>[0];
type OutputFinalTx = Parameters<
	TerminalClosure<TestInput, TestCheckpoint, TestResult, TestFailure, TestOutput, false>
>[0];
type OutputAbortFinalTx = Parameters<AbortClosure<TestInput, TestCheckpoint, TestAborted, TestOutput, false>>[0];

type KindAssertions = [
	Assert<Equal<TurnOf<typeof nonTurnKind>, false>>,
	Assert<Equal<TurnOf<typeof turnKind>, true>>,
	Assert<Equal<InputOf<typeof nonTurnKind>, TestInput>>,
	Assert<Equal<CheckpointOf<typeof nonTurnKind>, TestCheckpoint>>,
	Assert<Equal<ResultOf<typeof nonTurnKind>, TestResult>>,
	Assert<Equal<FailureOf<typeof nonTurnKind>, TestFailure>>,
	Assert<Equal<AbortedOf<typeof nonTurnKind>, TestAborted>>,
	Assert<Equal<PayloadsOf<typeof nonTurnKind>["aborted"], TestAborted>>,
	Assert<Equal<OutputOf<typeof nonTurnKind>, never>>,
	Assert<Equal<OutputOf<typeof outputTaskKind>, TestOutput>>,
	Assert<Equal<Parameters<typeof nonTurnKind.execute>[1], BaseTaskRuntime<TestInput, TestCheckpoint>>>,
	Assert<Equal<Parameters<typeof outputTaskKind.execute>[1]["output"], TaskOutput<TestOutput>>>,
	Assert<Equal<ReturnType<Parameters<TaskOutput<TestOutput>["mutate"]>[0]>, undefined>>,
	Assert<Equal<Parameters<typeof turnKind.execute>[1], TurnTaskRuntime<TestInput, TestCheckpoint>>>,
	Assert<Equal<Parameters<typeof nonTurnKind.abort>[1], BaseAbortRuntime<TestInput, TestCheckpoint>>>,
	Assert<Equal<Parameters<typeof turnKind.abort>[1], TurnAbortRuntime<TestInput, TestCheckpoint>>>,
	Assert<Equal<Parameters<typeof outputTaskKind.abort>[1]["output"], ReadonlyTaskOutput<TestOutput>>>,
	Assert<Equal<HasOutput<Parameters<typeof nonTurnKind.execute>[1]>, false>>,
	Assert<Equal<HasOutput<Parameters<typeof outputTaskKind.execute>[1]>, true>>,
	Assert<Equal<OutputFinalTx["output"], TestOutput>>,
	Assert<Equal<OutputAbortFinalTx["output"], TestOutput>>,
	Assert<Equal<HasEntry<NonTurnRuntimeTx>, false>>,
	Assert<Equal<HasEntry<TurnRuntimeTx>, true>>,
	Assert<Equal<HasEntry<NonTurnFinalTx>, false>>,
	Assert<Equal<HasEntry<TurnFinalTx>, true>>,
	Assert<Equal<HasEntry<NonTurnAbortTx>, false>>,
	Assert<Equal<HasEntry<TurnRuntimeAbortTx>, true>>,
	Assert<Equal<HasEntry<NonTurnAbortFinalTx>, false>>,
	Assert<Equal<HasEntry<TurnAbortFinalTx>, true>>,
	Assert<"sleep" extends keyof BaseAbortRuntime<TestInput, TestCheckpoint> ? false : true>,
];

type KindOutcome = Extract<TaskOf<typeof nonTurnKind>, { readonly status: "terminal" }>["outcome"];
type OutcomeAssertions = [
	Assert<Equal<KindOutcome, TaskOutcome<TestResult, TestFailure, TestAborted>>>,
	Assert<Equal<Extract<KindOutcome, { readonly status: "completed" }>["result"], TestResult>>,
	Assert<Equal<Extract<KindOutcome, { readonly status: "failed" }>["failure"], TestFailure>>,
	Assert<Equal<Extract<KindOutcome, { readonly status: "aborted" }>["result"], TestAborted>>,
];

const summaryKind = defineEntry<SummaryEntry>("pi.summary");
type SummaryInput = EntryInput<SummaryEntry>;
type EntryAssertions = [
	Assert<Equal<typeof summaryKind.kind, string>>,
	Assert<Equal<SummaryInput["head"], number | "self">>,
	Assert<"id" extends keyof SummaryInput ? false : true>,
	Assert<"conversationId" extends keyof SummaryInput ? false : true>,
	Assert<"kind" extends keyof SummaryInput ? false : true>,
	Assert<"byTaskId" extends keyof SummaryInput ? false : true>,
];

function verifyTaskInputs(
	tx: BaseTaskTx<TestCheckpoint>,
	outputRef: TaskOutputRef<TestOutput>,
	wrongOutputRef: TaskOutputRef<{ count: number }>,
): void {
	tx.task(nonTurnKind, {
		input: { prompt: "hello", nested: { count: 1 } },
	});
	tx.task(outputTaskKind, {
		input: { prompt: "own output", nested: { count: 1 } },
	});
	tx.task(outputTaskKind, {
		input: { prompt: "shared output", nested: { count: 1 } },
		output: outputRef,
	});
	// @ts-expect-error a no-output kind cannot receive an output reference
	tx.task(nonTurnKind, { input: { prompt: "hello", nested: { count: 1 } }, output: outputRef });
	tx.task(outputTaskKind, {
		input: { prompt: "wrong output", nested: { count: 1 } },
		// @ts-expect-error a shared output reference must have the kind's output type
		output: wrongOutputRef,
	});

	const exactVariable = {
		conversationId: 1,
		input: { prompt: "hello", nested: { count: 1 } },
		background: true,
	} as const;
	tx.task(nonTurnKind, exactVariable);

	// Top-level exactness intentionally does not recursively reject extra nested fields.
	tx.task(nonTurnKind, {
		input: { prompt: "hello", nested: { count: 1, extension: true } },
	});

	// @ts-expect-error task input literals reject extra top-level fields
	tx.task(nonTurnKind, { input: { prompt: "hello", nested: { count: 1 }, extension: true } });

	const extraInputVariable = { prompt: "hello", nested: { count: 1 }, extension: true };
	// @ts-expect-error task input variables reject visible extra top-level fields
	tx.task(nonTurnKind, { input: extraInputVariable });

	const inputBase = { prompt: "hello", nested: { count: 1 } };
	// @ts-expect-error task input spreads reject visible extra top-level fields
	tx.task(nonTurnKind, { input: { ...inputBase, extension: true } });

	const extraSpecVariable = {
		input: { prompt: "hello", nested: { count: 1 } },
		priority: 1,
	};
	// @ts-expect-error task specs reject visible extra top-level fields
	tx.task(nonTurnKind, extraSpecVariable);

	tx.checkpoint({ phase: "ready", cursor: 1 });
	// @ts-expect-error every checkpoint requires its phase
	tx.checkpoint({ cursor: 1 });
	// @ts-expect-error checkpoint replacement requires the complete kind-specific shape
	tx.checkpoint({ phase: "ready" });
	// @ts-expect-error an incompatible checkpoint shape is rejected
	tx.checkpoint({ phase: "ready", token: "cursor" });
}

function verifyOutputMutation(
	output: TaskOutput<TestOutput>,
	readonlyOutput: ReadonlyTaskOutput<TestOutput>,
	ctx: Context,
): void {
	void output.mutate((state) => {
		state.chunks.push("chunk");
	}, ctx);
	// @ts-expect-error task-output mutation callbacks must be synchronous
	void output.mutate(async (state) => {
		state.chunks.push("chunk");
	}, ctx);
	// @ts-expect-error fresh abort output is read-only
	void readonlyOutput.mutate;
}

function verifyCheckpointCompatibility(
	checkpoint: CheckpointOf<typeof sameCheckpointKind>,
	incompatible: CheckpointOf<typeof incompatibleCheckpointKind>,
): void {
	// Checkpoints are structural: an independently declared identical shape is assignable.
	const structurallyCompatible: CheckpointOf<typeof nonTurnKind> = checkpoint;
	void structurallyCompatible;
	// @ts-expect-error a differently shaped kind checkpoint is not assignable
	const structurallyIncompatible: CheckpointOf<typeof nonTurnKind> = incompatible;
	void structurallyIncompatible;
}

function verifyOutcomes(outcome: KindOutcome): void {
	const completed: KindOutcome = { status: "completed", result: { answer: "done" } };
	const failed: KindOutcome = { status: "failed", failure: { code: "failed" } };
	const aborted: KindOutcome = { status: "aborted", result: { cleaned: true } };
	const orphaned: KindOutcome = { status: "orphaned" };
	// @ts-expect-error completed outcomes require this kind's result payload
	const wrongCompleted: KindOutcome = { status: "completed", result: { answer: 1 } };
	// @ts-expect-error failed outcomes require this kind's failure payload
	const wrongFailure: KindOutcome = { status: "failed", failure: { code: "other" } };
	// @ts-expect-error aborted outcomes require this kind's abort payload
	const wrongAborted: KindOutcome = { status: "aborted", result: { cleaned: "yes" } };
	void outcome;
	void completed;
	void failed;
	void aborted;
	void orphaned;
	void wrongCompleted;
	void wrongFailure;
	void wrongAborted;
}

function verifyAddresses(): void {
	const sessionValue = defineValue<string>({ type: "session" }, "plugin.name");
	const taskList = defineList<number>({ type: "task", taskId: 2 }, "plugin.items", { key: "active" });
	const sharedList = defineList<number>({ type: "shared", id: 4 }, "plugin.shared");
	const conversationValue = defineValue<TestResult>({ type: "conversation", conversationId: 3 }, "plugin.result", {
		rewind: true,
	});
	const conversationList = defineList<string>({ type: "conversation", conversationId: 3 }, "plugin.events", {
		rewind: false,
	});
	const typedSessionValue: Value<string> = sessionValue;
	const typedTaskList: List<number> = taskList;
	void typedSessionValue;
	void typedTaskList;
	void sharedList;
	void conversationValue;
	void conversationList;

	// @ts-expect-error conversation addresses explicitly select rewind behavior
	defineValue<string>({ type: "conversation", conversationId: 3 }, "plugin.value");
	// @ts-expect-error session addresses are sticky
	defineValue<string>({ type: "session" }, "plugin.value", { rewind: true });
	// @ts-expect-error task addresses are never rewindable
	defineList<string>({ type: "task", taskId: 2 }, "plugin.list", { rewind: true });
	// @ts-expect-error shared addresses are never rewindable
	defineList<string>({ type: "shared", id: 4 }, "plugin.shared", { rewind: true });
	// @ts-expect-error address payloads are strict JSON
	defineValue<Date>({ type: "session" }, "plugin.date");
}

type ExactInputAssertion = Assert<
	Equal<ExactJsonInput<TestInput, TestInput & { readonly extension: boolean }>["extension"], never>
>;

declare const jsonAssertions: JsonAssertions;
declare const kindAssertions: KindAssertions;
declare const outcomeAssertions: OutcomeAssertions;
declare const entryAssertions: EntryAssertions;
declare const exactInputAssertion: ExactInputAssertion;
declare const entry: Entry;
void jsonAssertions;
void kindAssertions;
void outcomeAssertions;
void entryAssertions;
void exactInputAssertion;
void entry;
void verifyTaskInputs;
void verifyOutputMutation;
void verifyCheckpointCompatibility;
void verifyOutcomes;
void verifyAddresses;
