import type { Context } from "@earendil-works/chord";
import type { Id, JsonObject, JsonValue } from "./core.ts";
import type { AbortClosure, AbortRuntimeFor, RuntimeFor, TerminalClosure } from "./runtime.ts";

export interface TaskCheckpoint extends JsonObject {
	readonly phase: string;
}

export type NoCheckpoint = never;

declare const taskOutputType: unique symbol;

export interface TaskOutputKind<O extends object> {
	readonly kind: string;
	readonly [taskOutputType]?: O;
}

export function defineTaskOutput<O extends object>(kind: string): TaskOutputKind<O> {
	return Object.freeze({ kind });
}

export interface TaskOutputSpec<I extends JsonValue, O extends object> {
	readonly kind: TaskOutputKind<O>;
	initial(input: I): O;
}

export interface StoredTaskOutputRef {
	readonly id: Id;
	readonly kind: string;
}

export interface TaskOutputRef<O extends object> extends StoredTaskOutputRef {
	readonly [taskOutputType]?: O;
}

export type TaskOutputField<O extends object> = [O] extends [never] ? unknown : { readonly output: TaskOutputRef<O> };

type TaskOutputDefinition<I extends JsonValue, O extends object> = [O] extends [never]
	? { readonly output?: never }
	: { readonly output: TaskOutputSpec<I, O> };

export type TaskOutcome<R extends JsonValue, F extends JsonValue, A extends JsonValue> =
	| { readonly status: "completed"; readonly result: R }
	| { readonly status: "failed"; readonly failure: F }
	| { readonly status: "aborted"; readonly result: A }
	| { readonly status: "orphaned" };

export interface TaskBase<I extends JsonValue, C extends TaskCheckpoint> {
	readonly id: Id;
	readonly conversationId: Id;
	readonly kind: string;
	readonly input: I;
	readonly checkpoint?: C;
	readonly after: readonly Id[];
	readonly background?: true;
	readonly turn?: true;
	readonly owns: readonly Id[];
	readonly output?: StoredTaskOutputRef;
	readonly abort?: true;
}

export type Task<
	I extends JsonValue = JsonValue,
	C extends TaskCheckpoint = TaskCheckpoint,
	R extends JsonValue = JsonValue,
	F extends JsonValue = JsonValue,
	A extends JsonValue = JsonValue,
> = TaskBase<I, C> &
	(
		| { readonly status: "pending" | "running"; readonly outcome?: never }
		| { readonly status: "terminal"; readonly outcome: TaskOutcome<R, F, A> }
	);

export type RunningTask<I extends JsonValue, C extends TaskCheckpoint, O extends object = never> = Omit<
	TaskBase<I, C>,
	"output"
> &
	TaskOutputField<O> & {
		readonly status: "running";
		readonly outcome?: never;
	};

export type Completion<R extends JsonValue, F extends JsonValue> =
	| { readonly status: "completed"; readonly result: R }
	| { readonly status: "failed"; readonly failure: F };

const taskKindBrand: unique symbol = Symbol("pico.taskKind");

export interface TaskKindBase {
	readonly kind: string;
	readonly turn: false | true;
	readonly [taskKindBrand]: true;
}

interface TaskKindMethods<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends object,
	T extends false | true,
> extends TaskKindBase {
	readonly turn: T;
	execute(
		task: RunningTask<I, C, O>,
		runtime: RuntimeFor<I, C, O, T>,
		ctx: Context,
	): Promise<TerminalClosure<I, C, R, F, O, T>>;
	recover(
		task: RunningTask<I, C, O>,
		runtime: RuntimeFor<I, C, O, T>,
		ctx: Context,
	): Promise<TerminalClosure<I, C, R, F, O, T>>;
	abort(
		task: RunningTask<I, C, O>,
		runtime: AbortRuntimeFor<I, C, O, T>,
		ctx: Context,
	): Promise<AbortClosure<I, C, A, O, T>>;
}

export type TaskKind<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends object = never,
	T extends false | true = false,
> = TaskKindMethods<I, C, R, F, A, O, T> & TaskOutputDefinition<I, O>;

export type NoExtra<Expected, Actual extends Expected> = Actual & Record<Exclude<keyof Actual, keyof Expected>, never>;

export type ExactJsonInput<Expected extends JsonValue, Actual extends Expected> = Expected extends readonly JsonValue[]
	? Actual
	: Expected extends JsonObject
		? Actual & Record<Exclude<keyof Actual, keyof Expected>, never>
		: Actual;

export type NonTurnKindDefinition<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends object,
> = Omit<TaskKind<I, C, R, F, A, O, false>, "turn" | typeof taskKindBrand> & { readonly turn?: false };

export type TurnKindDefinition<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends object,
> = Omit<TaskKind<I, C, R, F, A, O, true>, typeof taskKindBrand>;

export interface TaskKindFactory<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends object,
> {
	<D extends NonTurnKindDefinition<I, C, R, F, A, O>>(
		definition: NoExtra<NonTurnKindDefinition<I, C, R, F, A, O>, D>,
	): D & TaskKind<I, C, R, F, A, O, false>;
	<D extends TurnKindDefinition<I, C, R, F, A, O>>(
		definition: NoExtra<TurnKindDefinition<I, C, R, F, A, O>, D>,
	): D & TaskKind<I, C, R, F, A, O, true>;
}

export function defineTask<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends object = never,
>(): TaskKindFactory<I, C, R, F, A, O> {
	const define = (definition: NonTurnKindDefinition<I, C, R, F, A, O> | TurnKindDefinition<I, C, R, F, A, O>) =>
		Object.freeze({
			...definition,
			turn: definition.turn ?? false,
			[taskKindBrand]: true as const,
		});
	return define as TaskKindFactory<I, C, R, F, A, O>;
}

export type AnyTaskKind = TaskKindBase;
export type PayloadsOf<K> = K extends TaskKind<infer I, infer C, infer R, infer F, infer A, infer O, false | true>
	? { input: I; checkpoint: C; result: R; failure: F; aborted: A; output: O }
	: never;
export type InputOf<K> = PayloadsOf<K>["input"];
export type CheckpointOf<K> = PayloadsOf<K>["checkpoint"];
export type ResultOf<K> = PayloadsOf<K>["result"];
export type FailureOf<K> = PayloadsOf<K>["failure"];
export type AbortedOf<K> = PayloadsOf<K>["aborted"];
export type OutputOf<K> = PayloadsOf<K>["output"];
export type TurnOf<K extends TaskKindBase> = K["turn"];
type WithoutOutput<T> = T extends unknown ? Omit<T, "output"> : never;

export type TaskOf<K extends TaskKindBase> = WithoutOutput<
	Task<InputOf<K>, CheckpointOf<K>, ResultOf<K>, FailureOf<K>, AbortedOf<K>>
> &
	TaskOutputField<OutputOf<K>>;
