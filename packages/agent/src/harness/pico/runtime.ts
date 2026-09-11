import type { Context } from "@earendil-works/chord";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { Element, List, Value } from "./addresses.ts";
import type { Id, JsonValue } from "./core.ts";
import type { ContextEdit, Conversation, Entry, EntryInput, EntryKind } from "./entries.ts";
import type {
	AnyTaskKind,
	Completion,
	ExactJsonInput,
	InputOf,
	NoExtra,
	OutputOf,
	RunningTask,
	Task,
	TaskCheckpoint,
	TaskOf,
	TaskOutputRef,
} from "./tasks.ts";

export interface Cursor {
	readonly after?: Id;
	readonly before?: Id;
	readonly limit: number;
}

export interface Page<T> {
	readonly items: readonly T[];
	readonly next?: Id;
	readonly readAt: Id;
}

export interface ListQuery extends Cursor {
	readonly at?: Id;
}

export interface TxReaders {
	getConversation(id: Id): Promise<Conversation | undefined>;
	getEntry(id: Id): Promise<Entry | undefined>;
	getEntry<E extends Entry>(kind: EntryKind<E>, id: Id): Promise<E | undefined>;
	getEntries(ids: readonly Id[]): Promise<ReadonlyMap<Id, Entry>>;
	getTask(id: Id): Promise<Task | undefined>;
	getTask<K extends AnyTaskKind>(kind: K, id: Id): Promise<TaskOf<K> | undefined>;
	getTasks(ids: readonly Id[]): Promise<ReadonlyMap<Id, Task>>;
}

export interface TxValue<T extends JsonValue> {
	get(at?: Id): Promise<T | undefined>;
	set(value: T): void;
	delete(): void;
}

export interface TxList<T extends JsonValue> {
	read(query: ListQuery): Promise<Page<Element<T>>>;
	append(value: T): Id;
	remove(id: Id): void;
	clear(): void;
}

export interface Acceptance {
	readonly requestId?: string;
	readonly conversationId: Id;
	readonly inputId: Id;
}

interface TaskSpecBase<I extends JsonValue> {
	readonly conversationId?: Id;
	readonly input: I;
	readonly after?: readonly Id[];
	readonly background?: true;
}

export type TaskSpec<I extends JsonValue, O extends object = never> = TaskSpecBase<I> &
	([O] extends [never] ? { readonly output?: never } : { readonly output?: TaskOutputRef<O> });

export interface ConversationCreateSpec {
	readonly parent?: { readonly conversationId: Id; readonly at: Id };
}

export type UserInput = string | readonly (TextContent | ImageContent)[];

export interface StoredEntryDraft {
	readonly kind: string;
	readonly data?: JsonValue;
	readonly model?: readonly Message[];
	readonly head?: Id | "self";
	readonly edits?: readonly ContextEdit[];
}

export type QueuedInput =
	| { readonly mode: "steer" | "followUp" | "nextRun"; readonly input: UserInput; readonly requestId?: string }
	| { readonly mode: "write"; readonly entry: StoredEntryDraft; readonly requestId?: string };

export type InputResult =
	| { readonly status: "queued"; readonly requestId?: string }
	| { readonly status: "placed"; readonly requestId?: string; readonly entry: Id }
	| { readonly status: "done"; readonly requestId?: string; readonly entry: Id; readonly answer?: Id }
	| {
			readonly status: "unanswered";
			readonly requestId?: string;
			readonly entry?: Id;
			readonly reason: "terminated" | "aborted" | "failed" | "stale";
			readonly detail?: string;
	  };

export type TerminalInputResult = Extract<InputResult, { status: "done" | "unanswered" }>;

export interface AcceptOptions {
	readonly input: UserInput;
	readonly requestId?: string;
	readonly whenBusy?: "followUp" | "steer" | "reject";
}

export interface BaseTaskTx<C extends TaskCheckpoint> extends TxReaders {
	checkpoint(value: C): void;
	task<K extends AnyTaskKind, S extends TaskSpec<InputOf<K>, OutputOf<K>>>(
		kind: K,
		spec: NoExtra<TaskSpec<InputOf<K>, OutputOf<K>>, S> & {
			readonly input: ExactJsonInput<InputOf<K>, S["input"]>;
		},
	): Id;
	createConversation(spec: ConversationCreateSpec): Id;
	value<T extends JsonValue>(address: Value<T>): TxValue<T>;
	list<T extends JsonValue>(address: List<T>): TxList<T>;
	accept(conversationId: Id, options: AcceptOptions): Promise<Acceptance>;
	queueInput(conversationId: Id, input: QueuedInput): Promise<Acceptance>;
	write<E extends Entry>(
		conversationId: Id,
		kind: EntryKind<E>,
		input: EntryInput<E>,
		requestId?: string,
	): Promise<Acceptance>;
}

export interface TurnTaskTx<C extends TaskCheckpoint> extends BaseTaskTx<C> {
	entry<E extends Entry>(kind: EntryKind<E>, conversationId: Id, input: EntryInput<E>): Id;
}

export interface PublicValue<T extends JsonValue> {
	get(at: Id | undefined, ctx: Context): Promise<T | undefined>;
	set(value: T, ctx: Context): Promise<void>;
	delete(ctx: Context): Promise<void>;
}

export interface PublicList<T extends JsonValue> {
	read(query: ListQuery, ctx: Context): Promise<Page<Element<T>>>;
	append(value: T, ctx: Context): Promise<Id>;
	remove(id: Id, ctx: Context): Promise<void>;
	clear(ctx: Context): Promise<void>;
}

export interface TaskOutput<O extends object> {
	readonly ref: TaskOutputRef<O>;
	read(ctx: Context): Promise<O>;
	mutate(mutator: (state: O) => undefined, ctx: Context): Promise<void>;
	replace(value: O, ctx: Context): Promise<void>;
}

export interface ReadonlyTaskOutput<O extends object> {
	readonly ref: TaskOutputRef<O>;
	read(ctx: Context): Promise<O>;
}

type RuntimeOutput<O extends object> = [O] extends [never] ? unknown : { readonly output: TaskOutput<O> };

type AbortRuntimeOutput<O extends object> = [O] extends [never] ? unknown : { readonly output: ReadonlyTaskOutput<O> };

type FinalOutput<O extends object> = [O] extends [never] ? unknown : { readonly output: O };

export interface ScratchTx {
	value<T extends JsonValue>(address: Value<T>): TxValue<T>;
	list<T extends JsonValue>(address: List<T>): TxList<T>;
}

export interface ScratchReader {
	value<T extends JsonValue>(address: Value<T>): Pick<TxValue<T>, "get">;
	list<T extends JsonValue>(address: List<T>): Pick<TxList<T>, "read">;
}

export interface TaskConversation {
	readonly id: Id;
	accept(options: AcceptOptions, ctx: Context): Promise<Acceptance>;
	queueInput(input: QueuedInput, ctx: Context): Promise<Acceptance>;
	write<E extends Entry>(
		kind: EntryKind<E>,
		input: EntryInput<E>,
		requestId: string | undefined,
		ctx: Context,
	): Promise<Acceptance>;
	result(inputId: Id, ctx: Context): Promise<InputResult | undefined>;
	waitForInput(inputId: Id, ctx: Context): Promise<TerminalInputResult>;
	abortInput(inputId: Id, ctx: Context): Promise<"aborted" | "already_placed" | "not_found">;
	value<T extends JsonValue>(address: Value<T>): PublicValue<T>;
	list<T extends JsonValue>(address: List<T>): PublicList<T>;
}

export interface AbortTaskConversation {
	readonly id: Id;
	write<E extends Entry>(
		kind: EntryKind<E>,
		input: EntryInput<E>,
		requestId: string | undefined,
		ctx: Context,
	): Promise<Acceptance>;
	result(inputId: Id, ctx: Context): Promise<InputResult | undefined>;
	waitForInput(inputId: Id, ctx: Context): Promise<TerminalInputResult>;
	value<T extends JsonValue>(address: Value<T>): PublicValue<T>;
	list<T extends JsonValue>(address: List<T>): PublicList<T>;
}

export interface BaseTaskRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends object = never> {
	readonly taskId: Id;
	commit<T>(build: (tx: BaseTaskTx<C>, current: RunningTask<I, C, O>) => T | Promise<T>, ctx: Context): Promise<T>;
	scratch<T>(build: (tx: ScratchTx) => T | Promise<T>, ctx: Context): Promise<T>;
	conversation(id: Id, ctx: Context): Promise<TaskConversation | undefined>;
	waitForTask(id: Id, ctx: Context): Promise<Task>;
	abortTask(id: Id, ctx: Context): Promise<"marked" | "terminal">;
	now(): number;
	sleep(untilMs: number, ctx: Context): Promise<void>;
}

export interface TurnTaskRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends object = never>
	extends Omit<BaseTaskRuntime<I, C, O>, "commit"> {
	commit<T>(build: (tx: TurnTaskTx<C>, current: RunningTask<I, C, O>) => T | Promise<T>, ctx: Context): Promise<T>;
}

export type RuntimeFor<
	I extends JsonValue,
	C extends TaskCheckpoint,
	O extends object,
	T extends false | true,
> = (T extends true ? TurnTaskRuntime<I, C, O> : BaseTaskRuntime<I, C, O>) & RuntimeOutput<O>;

export interface TerminalTx<C extends TaskCheckpoint> extends BaseTaskTx<C> {}
export interface TurnTerminalTx<C extends TaskCheckpoint> extends TurnTaskTx<C> {}

export type FinalTx<C extends TaskCheckpoint, O extends object, T extends false | true> = (T extends true
	? TurnTerminalTx<C>
	: TerminalTx<C>) &
	FinalOutput<O>;

export type TerminalClosure<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	O extends object,
	T extends false | true,
> = (tx: FinalTx<C, O, T>, current: RunningTask<I, C, O>) => Completion<R, F> | Promise<Completion<R, F>>;

export interface AbortTx<C extends TaskCheckpoint> extends TxReaders {
	checkpoint(value: C): void;
	value<T extends JsonValue>(address: Value<T>): TxValue<T>;
	list<T extends JsonValue>(address: List<T>): TxList<T>;
	write<E extends Entry>(
		conversationId: Id,
		kind: EntryKind<E>,
		input: EntryInput<E>,
		requestId?: string,
	): Promise<Acceptance>;
	markTask(id: Id): Promise<"marked" | "terminal">;
}

export interface TurnAbortTx<C extends TaskCheckpoint> extends AbortTx<C> {
	entry<E extends Entry>(kind: EntryKind<E>, conversationId: Id, input: EntryInput<E>): Id;
}

export type AbortFinalTx<C extends TaskCheckpoint, O extends object, T extends false | true> = (T extends true
	? TurnAbortTx<C>
	: AbortTx<C>) &
	FinalOutput<O>;

export type AbortClosure<
	I extends JsonValue,
	C extends TaskCheckpoint,
	A extends JsonValue,
	O extends object,
	T extends false | true,
> = (tx: AbortFinalTx<C, O, T>, current: RunningTask<I, C, O>) => A | Promise<A>;

export interface BaseAbortRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends object = never> {
	readonly taskId: Id;
	commit<T>(build: (tx: AbortTx<C>, current: RunningTask<I, C, O>) => T | Promise<T>, ctx: Context): Promise<T>;
	scratch<T>(read: (scratch: ScratchReader) => T | Promise<T>, ctx: Context): Promise<T>;
	conversation(id: Id, ctx: Context): Promise<AbortTaskConversation | undefined>;
	waitForTask(id: Id, ctx: Context): Promise<Task>;
	abortTask(id: Id, ctx: Context): Promise<"marked" | "terminal">;
	now(): number;
}

export interface TurnAbortRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends object = never>
	extends Omit<BaseAbortRuntime<I, C, O>, "commit"> {
	commit<T>(build: (tx: TurnAbortTx<C>, current: RunningTask<I, C, O>) => T | Promise<T>, ctx: Context): Promise<T>;
}

export type AbortRuntimeFor<
	I extends JsonValue,
	C extends TaskCheckpoint,
	O extends object,
	T extends false | true,
> = (T extends true ? TurnAbortRuntime<I, C, O> : BaseAbortRuntime<I, C, O>) & AbortRuntimeOutput<O>;
