/**
 * harness-v3 — records, documents, storage, kinds, transactions, runtime, tools, hooks.
 *
 * Durable model: four tables (conversations, entries, tasks, inputs) and three documents
 * (session, per-conversation rewindable, per-conversation sticky). Every durable position
 * is strict JSON (`JsonValue`); nothing durable is `unknown`.
 *
 * Single process. A storage path has one owning process and one owning Session at a time.
 * Two processes opening the same JSONL directory is unsupported.
 */
import type { JsonValue as ChordJsonValue, Context, JsonRepresentation } from "@earendil-works/chord";
import type { Op } from "@earendil-works/chord/delta";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	DeferredHandle,
	ImageContent,
	Message as ModelMessage,
	Model as ModelOf,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import type { ThinkingLevel } from "../../types.ts";
import type { SectionRegistry, SectionSeed, ToolRegistry } from "./system.ts";

// ---------------------------------------------------------------------------
// Strict durable JSON
// ---------------------------------------------------------------------------

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = ChordJsonValue;
/** Optional properties represent absent keys; committed values are normalized through JSON serialization. */
export type JsonObject = { [key: string]: JsonValue };

/** Coerce an in-memory value (e.g. a pi-ai message) to its stored representation. */
export const toStored = <T>(value: T): Stored<T> => JSON.parse(JSON.stringify(value)) as Stored<T>;

/**
 * The JSON representation of a value: what survives `JSON.parse(JSON.stringify(v))`.
 * Optional keys stay optional; `undefined` values vanish; functions are never durable.
 * Use for imported pi-ai types at durable positions.
 */
export type Stored<T> = JsonRepresentation<T>;

export type Id = number;
export type Seq = number;

/** Compile-time assertion helper. */
export type Assert<T extends true> = T;
/** True iff T is strict JSON (structurally). */
export type IsJson<T> = [T] extends [JsonValue] ? true : false;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface Conversation {
	readonly id: Id;
	readonly parent?: { readonly conversationId: Id; readonly at: Id };
	readonly owner?: Id; // task that created it
	/** §8.1 section seed: applied by preparation while the conversation has no local managed entry. Private: not in ConversationView. */
	readonly sections?: readonly SectionSeed[];
}

/**
 * System instructions and the tool loadout ride inside `messages` (pi-ai PR #9116, shimmed
 * here until it lands): a SystemMessage at its historical position.
 */
export interface SystemMessage {
	role: "system";
	content: string;
	toolsAdded?: { name: string; description: string; parameters: TSchema }[];
	toolsRemoved?: { name: string }[];
	timestamp: number;
}
export type Message = ModelMessage | SystemMessage;
export type StoredMessage = Stored<Message>;
export type Model = ModelOf<Api>;

export interface ContextEdit {
	readonly target: Id;
	readonly action: "omit" | "replace";
	readonly messages?: readonly StoredMessage[];
}

export interface Entry {
	readonly id: Id;
	readonly conversationId: Id;
	readonly kind: string;
	readonly model?: readonly StoredMessage[]; // what the model sees; absent = display/bookkeeping only
	readonly data?: JsonObject;
	readonly head?: Id; // context starts here (may be a parent's entry). Assigned by the kernel; `self` in NewEntry
	readonly edits?: readonly ContextEdit[];
	readonly byTaskId?: Id;
}
export type NewEntry = Omit<Entry, "id" | "conversationId" | "byTaskId" | "head"> & { readonly head?: Id | "self" };

/** A typed witness for an entry kind: `is()` narrows, and typed writes take `EntryInput<E>`. */
export interface EntryKind<E extends Entry = Entry> {
	readonly kind: string;
	is(entry: Entry | undefined): entry is E;
}
export type EntryInput<E extends Entry> = Omit<E, "id" | "conversationId" | "kind" | "byTaskId" | "head"> &
	(E extends { readonly head: Id } ? { readonly head: Id | "self" } : { readonly head?: never });
export function defineEntry<E extends Entry>(kind: string): EntryKind<E> {
	if (kind.startsWith("pi.")) throw new Error(`entry kind names beginning with "pi." are reserved: ${kind}`);
	return Object.freeze({ kind, is: (entry: Entry | undefined): entry is E => entry?.kind === kind });
}

export type Checkpoint = JsonObject & { readonly phase: string };

export type Completion<R extends JsonValue = JsonValue, F extends JsonValue = JsonValue> =
	| { readonly status: "completed"; readonly result: R }
	| { readonly status: "failed"; readonly failure: F };
export type Outcome<R extends JsonValue = JsonValue, F extends JsonValue = JsonValue, A extends JsonValue = JsonValue> =
	| Completion<R, F>
	| { readonly status: "aborted"; readonly result: A }
	| { readonly status: "orphaned" }
	/** The kind broke its contract (a handler threw or returned an invalid shape). Not one of its declared failures. */
	| { readonly status: "faulted"; readonly error: string };

export interface Task<I extends JsonValue = JsonValue, C extends Checkpoint = Checkpoint> {
	readonly id: Id;
	readonly conversationId: Id;
	readonly kind: string;
	readonly input: I;
	readonly status: "pending" | "running" | "terminal";
	readonly checkpoint?: C;
	readonly abort?: true; // the durable mark
	readonly outcome?: Outcome;
	readonly after: readonly Id[];
	readonly owns: readonly Id[]; // conversations this task created
	readonly background?: true; // does not hold the conversation busy; survives conversation abort
}
export type TaskPatch = { readonly id: Id } & Partial<
	Omit<Pick<Task, "status" | "checkpoint" | "abort" | "outcome" | "owns">, "checkpoint">
> & { checkpoint?: Checkpoint | null };

export interface Input {
	readonly id: Id;
	readonly conversationId: Id;
	readonly requestId?: string;
	readonly status: "queued" | "placed" | "done" | "unanswered";
	readonly entry?: Id;
	readonly answer?: Id;
	readonly reason?: "aborted" | "stale" | "terminated" | "failed";
	readonly detail?: string;
}

// ---------------------------------------------------------------------------
// Documents (Chord-tracked). Mutated in place inside a commit, diffed at the end.
// ---------------------------------------------------------------------------

export type ModelRef = { provider: string; modelId: string };
export type RetryPolicy = { enabled: boolean; maxRetries: number; baseDelayMs: number; maxAgentDelayMs?: number };

/** One running tool call, at the index of its call in the assistant message. */
export type ToolSlot = {
	callId: string;
	name: string;
	args: JsonValue;
	status: "pending" | "running" | "done" | "error" | "aborted";
	waitingOn?: string;
	output?: string; // bounded stream as it stands
	progress?: string;
	details?: JsonValue;
	continuedBy?: Id; // a background task that took the work over; its live state is `tasks[continuedBy]`
	entry?: Id;
	/** Private task-lifetime coordination state. Never projected into ConversationView. */
	memos?: { [key: string]: JsonValue };
};
/** The current turn, shaped for rendering. Reset when a generation starts; cleared when the turn ends. */
export type TurnState = {
	message?: Stored<AssistantMessage>; // streaming assistant message
	tools: ToolSlot[]; // tools of the assistant message being executed, by call index
};

/** Private durable namespace slices stored in authoritative documents. */
export type PluginSlices = { [namespace: string]: JsonObject };

/** Rewound by forks: forks see the state as of their fork point. Core config fields come from the built-in kinds' declarations. */
export type RewindableState = {
	model?: ModelRef;
	thinkingLevel: ThinkingLevel;
	selectedTools: string[];
	profile: string;
	threshold: number;
	keepRecent: number;
	plugins: PluginSlices;
	[key: string]: JsonValue | undefined; // ordinary kinds' declared config, keyed by their disjoint names
};
/** The present. Never folded historically; truncated to its last base. */
export type StickyState = {
	retry: RetryPolicy;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	inbox: QueuedInput[];
	turn: TurnState;
	tasks: { [taskId: string]: JsonObject }; // non-turn tasks' live slots; retired by the kernel on terminal
	plugins: PluginSlices;
	[key: string]: JsonValue | undefined;
};
export type SessionState = { plugins: PluginSlices; [key: string]: JsonValue | undefined };

export type QueuedInput =
	| { id: Id; mode: "steer" | "followUp"; input: Stored<UserInput> }
	| { id: Id; mode: "write"; entry: Stored<NewEntry> };

export type DocRef =
	| { doc: "session" }
	| { doc: "rewindable"; conversationId: Id }
	| { doc: "sticky"; conversationId: Id };

export type NamespaceDefaults<T extends JsonObject> = {
	readonly rewindable?: Partial<T>;
	readonly sticky?: Partial<T>;
	readonly session?: Partial<T>;
};

/** Current process authority for one durable namespace string. */
export interface Namespace<T extends JsonObject = JsonObject> {
	readonly id: string;
	/** Type-only invariant marker. */
	readonly valueType?: (value: T) => T;
	unregister(): void;
}

/** Internal erased registration paired with the public namespace token. */
export interface NamespaceRegistration {
	readonly token: object;
	readonly defaults: { readonly rewindable: JsonObject; readonly sticky: JsonObject; readonly session: JsonObject };
	readonly routes: ReadonlyMap<string, DocRef["doc"]>;
	readonly project?: (slice: Readonly<JsonObject>) => JsonValue;
}

/** First writer wins, including when the stored winner is null. */
export function memoOnce<T extends JsonValue>(slot: JsonObject, key: string, candidate: T): T {
	if (!Object.hasOwn(slot, "memos")) slot.memos = {};
	const memos = slot.memos as { [key: string]: JsonValue };
	if (Object.hasOwn(memos, key)) return memos[key] as T;
	memos[key] = candidate;
	return candidate;
}

// ---------------------------------------------------------------------------
// Configuration facade: every registered kind's `config` merged flat.
// ---------------------------------------------------------------------------

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
/** A declared slice; the undeclared `ConfigShape` (index signature) counts as no keys. */
type Declared<S> = string extends keyof S ? object : S;
type RewindableOf<K> = K extends unknown
	? ConfigOf<K> extends { readonly rewindable: infer RC }
		? Declared<RC>
		: object
	: never;
type StickyOf<K> = K extends unknown
	? ConfigOf<K> extends { readonly sticky: infer SC }
		? Declared<SC>
		: object
	: never;
export type ConfigOfKinds<Ks extends readonly AnyKind[]> = UnionToIntersection<
	RewindableOf<Ks[number]> | StickyOf<Ks[number]>
> extends infer M
	? { [K in keyof M]: M[K] }
	: never;
type KeysOfKind<K> = (keyof RewindableOf<K> | keyof StickyOf<K>) & string;
type IsUnion<U, C = U> = U extends unknown ? ([C] extends [U] ? false : true) : never;
/** The kinds declaring `Key`. */
type Owners<Ks extends readonly AnyKind[], Key extends string> = {
	[I in keyof Ks]: Key extends KeysOfKind<Ks[I]> ? Ks[I] : never;
}[number];
type AllKeys<Ks extends readonly AnyKind[]> = { [I in keyof Ks]: KeysOfKind<Ks[I]> }[number];
type ClashingKeys<Ks extends readonly AnyKind[]> = {
	[Key in AllKeys<Ks>]: true extends IsUnion<Owners<Ks, Key>> ? Key : never;
}[AllKeys<Ks>];
/** `true` iff no two kinds declare the same config key. Asserted at open at compile time and at runtime. */
export type DisjointConfig<Ks extends readonly AnyKind[]> = [ClashingKeys<Ks>] extends [never] ? true : false;

export interface ConfigFacade<Cfg extends object> {
	get(ctx: Context): Promise<Readonly<Cfg>>;
	/** One commit, routed to the declaring documents. */
	set(patch: { [K in keyof Cfg]?: Cfg[K] }, ctx: Context): Promise<void>;
	/** Delete persisted overrides. Declared defaults become visible; `model` becomes absent. */
	reset(keys: readonly (keyof Cfg)[], ctx: Context): Promise<void>;
}

// ---------------------------------------------------------------------------
// Storage: six write types, a handful of reads. One owning Session per instance.
// ---------------------------------------------------------------------------

export type Write =
	| { type: "conversation"; conversation: Conversation }
	| { type: "entry"; entry: Entry }
	| { type: "task"; task: Task } // create
	| { type: "task.patch"; patch: TaskPatch } // `checkpoint: null` clears
	| { type: "input"; input: Input } // create or replace whole
	| { type: "doc"; ref: DocRef; ops: Op[] };

export interface EntryScan {
	conversationId: Id;
	kind?: string;
	withHead?: boolean;
	before?: Id; // strictly less
	limit: number;
}
export interface TaskScan {
	conversationId?: Id;
	status?: Task["status"][];
	kind?: string;
}

export interface Storage {
	/** Persist one batch atomically: all or nothing. Returns the commit sequence. */
	commit(writes: readonly Write[], ctx: Context): Promise<Seq>;
	mintId(): Id;
	conversation(id: Id, ctx: Context): Promise<Conversation | undefined>;
	conversations(ctx: Context): Promise<Conversation[]>;
	entries(ids: readonly Id[], ctx: Context): Promise<Map<Id, Entry>>;
	/** Newest-first, fork-aware: this conversation's entries, then the parent's up to the fork point, and so on. */
	scanEntries(scan: EntryScan, ctx: Context): Promise<Entry[]>;
	task(id: Id, ctx: Context): Promise<Task | undefined>;
	scanTasks(scan: TaskScan, ctx: Context): Promise<Task[]>;
	input(id: Id, ctx: Context): Promise<Input | undefined>;
	inputByRequest(conversationId: Id, requestId: string, ctx: Context): Promise<Input | undefined>;
	doc(ref: DocRef, ctx: Context): Promise<JsonObject | undefined>;
	/** Rewindable doc as of the atomic commit containing entry `at` (fork inheritance). See "commit-granular history". */
	docAsOf(conversationId: Id, at: Id, ctx: Context): Promise<JsonObject | undefined>;
	/** Rewrite a doc log from its last base. */
	truncate(ref: DocRef, ctx: Context): Promise<void>;
	close(ctx: Context): Promise<void>;
}

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/** A hook may synchronously or asynchronously omit its replacement value. */
// biome-ignore lint/suspicious/noConfusingVoidType: void is the intentional callback no-value result
export type HookResult<T> = T | void | Promise<T | void>;

export interface HookApi {
	readonly kind: string;
	readonly taskId: Id;
	readonly conversationId: Id;
}
/** Kept as the concise name used by existing kind hook declarations. */
export type HookInfo = HookApi;
export interface HookBinding<H extends object> {
	readonly handlers: Partial<H>;
	readonly namespace: Namespace;
	readonly api: HookApi;
}
export interface HookRunner<H extends object> {
	handlers(): readonly HookBinding<H>[];
	/** Call `fn` on each handler; `onValue` sees non-undefined results and may return true to stop. A throwing handler is reported and skipped. */
	each<V>(
		ctx: Context,
		fn: (handlers: Partial<H>, api: HookApi) => HookResult<V>,
		onValue?: (v: V) => unknown,
	): Promise<void>;
}

/** What a phase handler returns: advance to a checkpoint, or finish. A builder runs on the line and may terminalize or ask to retry. */
export type Step<C extends Checkpoint, R extends JsonValue, F extends JsonValue, Tx extends TaskTx = TaskTx> =
	| {
			readonly next:
				| C
				| ((
						tx: Tx,
						current: Task,
						ctx: Context,
				  ) => C | Completion<R, F> | "retry" | Promise<C | Completion<R, F> | "retry">);
	  }
	| { readonly done: Closure<R, F, Tx> };
export type Closure<R extends JsonValue, F extends JsonValue, Tx extends TaskTx = TaskTx> = (
	tx: Tx,
	current: Task,
	ctx: Context,
) => Completion<R, F> | Promise<Completion<R, F>>;
export type AbortClosure<A extends JsonValue, Tx extends TaskTx = TaskTx> = (
	tx: Tx,
	current: Task,
	ctx: Context,
) => A | Promise<A>;

export type CheckpointAt<C extends Checkpoint, P extends C["phase"]> = Extract<C, { readonly phase: P }>;
export type PhaseHandler<
	I extends JsonValue,
	C extends Checkpoint,
	P extends C["phase"],
	R extends JsonValue,
	F extends JsonValue,
	H extends object,
	Tx extends TaskTx = TaskTx,
> = (
	task: Task<I, CheckpointAt<C, P>> & { readonly checkpoint: CheckpointAt<C, P> },
	rt: Runtime<H, Tx>,
	ctx: Context,
) => Promise<Step<C, R, F, Tx>>;

/** A config slice: JSON values; a key whose default is `undefined` is optional (only `model` among the built-ins). */
export type ConfigShape = { [key: string]: JsonValue | undefined };
/** Per-kind configuration: defaults, split by document. Keys across all kinds must be disjoint. */
export interface KindConfig<RC extends ConfigShape = ConfigShape, SC extends ConfigShape = ConfigShape> {
	readonly rewindable?: RC;
	readonly sticky?: SC;
}

/** Phantom carrier so `TaskOf<K>` etc. can read a kind's types back out. Never set at runtime. */
export interface KindTypes<
	I extends JsonValue,
	C extends Checkpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	H extends object,
	Cfg extends KindConfig,
	S extends JsonObject,
> {
	input: I;
	checkpoint: C;
	result: R;
	failure: F;
	aborted: A;
	hooks: H;
	config: Cfg;
	slot: S;
}

/**
 * A task kind. `initial` runs when there is no checkpoint; `phases` is exhaustive over
 * `C["phase"]`. Phases named in `inflight` are written by a handler immediately before an
 * external effect and are entered by the scheduler only after reopen; a `next` transition
 * into one is rejected as a contract fault.
 */
export interface Kind<
	I extends JsonValue = JsonValue,
	C extends Checkpoint = Checkpoint,
	R extends JsonValue = JsonValue,
	F extends JsonValue = JsonValue,
	A extends JsonValue = JsonValue,
	H extends object = object,
	Cfg extends KindConfig = KindConfig,
	S extends JsonObject = JsonObject,
	Tx extends TaskTx = TaskTx,
> {
	readonly types?: KindTypes<I, C, R, F, A, H, Cfg, S>;
	readonly name: string;
	/** A turn kind makes the conversation busy for admission. */
	readonly turn?: boolean;
	readonly config?: Cfg;
	/** Live slot (`sticky.tasks[id]`) initializer. */
	readonly slot?: (input: I) => S;
	/** Rendering projection for a non-turn task. Raw checkpoints and slots are never published. */
	readonly describe?: (task: Task<I, C> & { readonly slot?: Readonly<S> }) => JsonValue;
	readonly inflight?: readonly C["phase"][];
	initial(
		task: Task<I, never> & { readonly checkpoint?: undefined },
		rt: Runtime<H, Tx>,
		ctx: Context,
	): Promise<Step<C, R, F, Tx>>;
	readonly phases: { readonly [P in C["phase"]]: PhaseHandler<I, C, P, R, F, H, Tx> };
	abort(task: Task<I, C>, rt: Runtime<H, Tx>, ctx: Context): Promise<AbortClosure<A, Tx>>;
}

/** Internal kind type for fixed core machinery. */
export type CoreKind<
	I extends JsonValue,
	C extends Checkpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	H extends object = object,
	Cfg extends KindConfig = KindConfig,
	S extends JsonObject = JsonObject,
> = Kind<I, C, R, F, A, H, Cfg, S, CoreTx>;

/** Author an ordinary kind. Names may not begin with `pi.`. */
export function defineTask<
	I extends JsonValue,
	C extends Checkpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	H extends object = object,
	Cfg extends KindConfig = KindConfig,
	S extends JsonObject = JsonObject,
>(definition: Kind<I, C, R, F, A, H, Cfg, S>): Kind<I, C, R, F, A, H, Cfg, S> {
	if (definition.name.startsWith("pi."))
		throw new Error(`task kind names beginning with "pi." are reserved: ${definition.name}`);
	return Object.freeze({ ...definition });
}

/**
 * The erased kind the kernel stores. Handlers are invoked through `KindAdapter`, the one
 * place a concrete `Kind<…>` is narrowed to this and its outputs are validated.
 */
export interface AnyKind {
	readonly types?: unknown;
	readonly name: string;
	readonly turn?: boolean;
	readonly config?: KindConfig;
	readonly slot?: (input: never) => JsonObject;
	readonly describe?: unknown;
	readonly inflight?: readonly string[];
	readonly initial: unknown;
	readonly phases: { readonly [phase: string]: unknown };
	readonly abort: unknown;
}

export interface TaskRef<K extends AnyKind = AnyKind> {
	readonly id: Id;
	readonly kind: K;
}
export interface EntryRef<E extends Entry = Entry> {
	readonly id: Id;
	readonly kind: EntryKind<E>;
}

type TypesOf<K> = K extends { types?: infer T } ? NonNullable<T> : never;
export type TaskOf<K> = TypesOf<K> extends KindTypes<
	infer I,
	infer C,
	infer R,
	infer F,
	infer A,
	object,
	KindConfig,
	JsonObject
>
	? Omit<Task<I, C>, "outcome"> & { readonly outcome?: Outcome<R, F, A> }
	: never;
export type InputOf<K> = TypesOf<K> extends KindTypes<
	infer I,
	Checkpoint,
	JsonValue,
	JsonValue,
	JsonValue,
	object,
	KindConfig,
	JsonObject
>
	? I
	: never;
export type HooksOf<K> = TypesOf<K> extends KindTypes<
	JsonValue,
	Checkpoint,
	JsonValue,
	JsonValue,
	JsonValue,
	infer H,
	KindConfig,
	JsonObject
>
	? H
	: never;
export type ConfigOf<K> = TypesOf<K> extends KindTypes<
	JsonValue,
	Checkpoint,
	JsonValue,
	JsonValue,
	JsonValue,
	object,
	infer Cfg,
	JsonObject
>
	? Cfg
	: never;
export type SlotOf<K> = TypesOf<K> extends KindTypes<
	JsonValue,
	Checkpoint,
	JsonValue,
	JsonValue,
	JsonValue,
	object,
	KindConfig,
	infer S
>
	? S
	: never;

export type TaskSpec = {
	kind: string;
	conversationId?: Id;
	input: JsonValue;
	after?: Id[];
	background?: true;
};

// ---------------------------------------------------------------------------
// Transactions. One implementation; three views.
// ---------------------------------------------------------------------------

export interface ConversationSpec {
	parent?: { conversationId: Id; at: Id | "start" };
	rewindable?: Partial<RewindableState>;
	sticky?: Partial<StickyState>;
	sections?: readonly SectionSeed[];
}
export interface OwnedConversationSpec {
	inherit?: boolean;
	rewindable?: Partial<RewindableState>;
	sticky?: Partial<StickyState>;
}
export type UserInput = string | UserMessage["content"];
export interface SendInput {
	content: UserInput;
	requestId?: string;
	whenBusy?: "steer" | "followUp" | "reject";
}
export type ContextView = { head: Entry | undefined; entries: Entry[]; messages: StoredMessage[] };

export type GenerationStatus =
	| { stage: "waiting"; on: "compaction" }
	| { stage: "preparing" }
	| { stage: "requesting"; attempt: number }
	| { stage: "streaming"; attempt: number }
	| { stage: "retrying"; attempt: number; retryAt: number; lastError: string }
	| { stage: "deferred"; attempt: number; pollAt: number };

export interface TurnView {
	inputs: Id[];
	generation?: GenerationStatus;
	message?: Stored<AssistantMessage>;
	tools: Omit<ToolSlot, "memos">[];
}

export interface ConversationView {
	conversation: Omit<Conversation, "sections">;
	entries: Entry[];
	config: { [key: string]: JsonValue | undefined };
	inbox: QueuedInput[];
	turn?: TurnView;
	compaction?: {
		taskId: Id;
		reason: "threshold" | "manual" | "overflow";
		stage: "summarizing" | "retrying";
		attempt: number;
		retryAt?: number;
	};
	tasks: { [taskId: string]: { kind: string; background?: true; marked?: true; status: JsonValue } };
	plugins: { [namespace: string]: JsonValue };
}

export type ViewEvent =
	| { type: "entry.added"; entry: Entry }
	| { type: "head.moved"; entry: Entry }
	| { type: "turn.started"; inputs: Id[] }
	| { type: "turn.ended"; inputs: Id[]; status: "done"; answer: Id }
	| {
			type: "turn.ended";
			inputs: Id[];
			status: "unanswered";
			reason: "terminated" | "aborted" | "failed" | "stale";
			detail?: string;
	  }
	| { type: "input.queued"; input: Id; mode: "steer" | "followUp" | "write" }
	| { type: "input.placed"; input: Id; entry: Id }
	| { type: "input.aborted"; input: Id }
	| { type: "generation.started"; taskId: Id; attempt: number }
	| { type: "generation.retrying"; taskId: Id; attempt: number; retryAt: number; error: string }
	| { type: "generation.deferred"; taskId: Id; pollAt: number }
	| { type: "generation.completed"; taskId: Id; entry: Id; toolCalls: number }
	| {
			type: "generation.failed";
			taskId: Id;
			reason: "provider" | "overflow" | "retries_exhausted" | "no_model";
			detail: string;
			entry?: Id;
	  }
	| { type: "tool.waiting"; taskId: Id; callId: string; on: string }
	| { type: "tool.started"; taskId: Id; callId: string; name: string }
	| { type: "tool.finished"; taskId: Id; callId: string; entry: Id; isError: boolean; control?: ToolControl }
	| { type: "tool.aborted"; taskId: Id; callId: string; entry: Id }
	| { type: "compaction.started"; taskId: Id; reason: "threshold" | "manual" | "overflow"; through: Id }
	| { type: "compaction.retrying"; taskId: Id; attempt: number; retryAt: number; error: string }
	| { type: "compaction.finished"; taskId: Id; summary: Id }
	| {
			type: "compaction.failed";
			taskId: Id;
			reason: "stale" | "declined" | "provider" | "retries_exhausted" | "no_model";
			detail: string;
	  }
	| { type: "task.started"; taskId: Id; kind: string; background?: true }
	| {
			type: "task.ended";
			taskId: Id;
			kind: string;
			outcome: "completed" | "failed" | "aborted" | "orphaned" | "faulted";
	  }
	| { type: "config.changed"; keys: string[] }
	| { type: "warning"; source: string; message: string }
	| { type: `plugin.${string}`; data: JsonValue };

export interface Envelope {
	readonly revision: number;
	readonly ops: Op[];
	readonly events: ViewEvent[];
}

/** Reads available to every view. Scans reject after a same-batch write to their domain (`ReadAfterWrite`). */
export interface TxReads {
	conversation(id: Id): Promise<Conversation | undefined>;
	entry(id: Id): Promise<Entry | undefined>;
	entry<E extends Entry>(kind: EntryKind<E>, id: Id): Promise<E | undefined>;
	entries(ids: readonly Id[]): Promise<Map<Id, Entry>>;
	newestEntry(conversationId: Id, opts?: { kind?: string; withHead?: boolean }): Promise<Entry | undefined>;
	newestEntry<E extends Entry>(conversationId: Id, kind: EntryKind<E>): Promise<E | undefined>;
	scanEntries(scan: EntryScan): Promise<Entry[]>;
	context(conversationId: Id, at?: Id): Promise<ContextView>;
	task(id: Id): Promise<Task | undefined>;
	task<K extends AnyKind>(ref: TaskRef<K>): Promise<TaskOf<K> | undefined>;
	tasks(scan: TaskScan): Promise<Task[]>;
	input(id: Id): Promise<Input | undefined>;
	rewindableAsOf(conversationId: Id, at: Id): Promise<RewindableState | undefined>;
	/** Plain copies. Document proxies cannot escape a transaction. */
	snapshot(ref: { doc: "rewindable"; conversationId: Id }): RewindableState;
	snapshot(ref: { doc: "sticky"; conversationId: Id }): StickyState;
	snapshot(ref: { doc: "session" }): SessionState;
}

interface SharedTx extends TxReads {
	plugins<T extends JsonObject>(namespace: Namespace<T>): T;
	emit<T extends JsonObject>(namespace: Namespace<T>, name: string, data: JsonValue): void;
	config(conversationId: Id): { get<K extends string>(key: K): JsonValue | undefined };
	/** Passive entry: queued when busy, appended when idle. Returns the input id. */
	write(conversationId: Id, entry: NewEntry): Promise<Id>;
	write<E extends Entry>(conversationId: Id, kind: EntryKind<E>, entry: EntryInput<E>): Promise<Id>;
	createTask<K extends AnyKind>(
		kind: K,
		input: InputOf<K>,
		opts?: { conversationId?: Id; background?: true; after?: Id[] },
	): TaskRef<K>;
	createConversation(spec: ConversationSpec): Id;
}

/** What the host gets. */
export interface HostTx extends SharedTx {
	/** Config through the facade; raw core fields are not exposed to the host tx. */
	config(conversationId: Id): {
		get<K extends string>(key: K): JsonValue | undefined;
		set(key: string, value: JsonValue): void;
		reset(key: string): void;
	};
}

/** What an ordinary task gets: scoped shared operations plus its own checkpoint and slot. */
export interface TaskTx extends SharedTx {
	checkpoint<C extends Checkpoint>(value: C): void;
	slot<K extends AnyKind>(ref: TaskRef<K>): SlotOf<K>;
	/** Create a conversation this task owns. `parent` must be in the task's subtree. */
	createConversation(spec: ConversationSpec): Id;
}

/** Internal full authority for the fixed turn machinery. Never handed to ordinary kinds or the host. */
export interface CoreTx extends TaskTx {
	emit<T extends JsonObject>(namespace: Namespace<T>, name: string, data: JsonValue): void;
	emit(event: ViewEvent): void;
	rewindable(conversationId: Id): RewindableState;
	sticky(conversationId: Id): StickyState;
	session(): SessionState;
	toolSlot(task: { conversationId: Id; input: { index: number } }): ToolSlot;
	appendEntry(conversationId: Id, entry: NewEntry): Id;
	appendEntry<E extends Entry>(conversationId: Id, kind: EntryKind<E>, entry: EntryInput<E>): EntryRef<E>;
	createTask(spec: TaskSpec): Id;
	createTask<K extends AnyKind>(
		kind: K,
		input: InputOf<K>,
		opts?: { conversationId?: Id; background?: true; after?: Id[] },
	): TaskRef<K>;
	send(conversationId: Id, input: SendInput): Promise<Id>;
	resolveInputs(
		ids: readonly Id[],
		resolution:
			| { status: "done"; answer: Id }
			| { status: "unanswered"; reason: NonNullable<Input["reason"]>; detail?: string },
	): Promise<void>;
	/** Inbox placement at a safe boundary. `headBoundary`: the newest head as the caller knows it (including a same-batch self-head it appended). */
	boundary(
		conversationId: Id,
		at: "postTools" | "final",
		headBoundary: Id | undefined,
	): Promise<{ triggers: Id[]; terminated: boolean }>;
	/** Internal owned-conversation path. Sanitizes caller overrides while preserving inherited rewindable namespace slices. */
	createOwnedConversation(ownerTaskId: Id, sourceConversationId: Id, spec: OwnedConversationSpec): Promise<Id>;
	/** Internal host-fork path for an already validated historical snapshot. */
	createForkConversation(spec: ConversationSpec): Id;
	markTask(id: Id): void;
}

/** Thrown when a scan-shaped read follows a same-batch write to its domain. Poisons the transaction. */
export class ReadAfterWrite extends Error {
	constructor(read: string, write: string) {
		super(`${read} after ${write} in the same transaction: the answer would not include the buffered write`);
		this.name = "ReadAfterWrite";
	}
}

// ---------------------------------------------------------------------------
// Runtime: what a kind's handlers get. Every commit checks the invocation token.
// ---------------------------------------------------------------------------

export interface RequestOptions {
	messages: StoredMessage[];
	thinkingLevel: ThinkingLevel;
}
export interface Models {
	resolve(ref: ModelRef): Model | undefined;
	stream(model: Model, request: RequestOptions, ctx: Context): AsyncIterable<AssistantMessageEvent>;
	fetchDeferred(
		model: Model,
		handle: DeferredHandle,
		ctx: Context,
	): Promise<AssistantMessage | { deferred: DeferredHandle }>;
	cancelDeferred(model: Model, handle: DeferredHandle, ctx: Context): Promise<void>;
}

export interface Runtime<H extends object = object, Tx extends TaskTx = TaskTx> {
	readonly taskId: Id;
	readonly conversationId: Id;
	readonly kind: AnyKind;
	commit<T>(fn: (tx: Tx, current: Task, ctx: Context) => T | Promise<T>, ctx: Context): Promise<T>;
	readonly hooks: HookRunner<H>;
	readonly models: Models;
	readonly tools: ReadonlyMap<string, ToolDeclaration>;
	readonly registries: { sections: SectionRegistry; tools: ToolRegistry };
	readonly kinds: ReadonlyMap<string, AnyKind>;
	readonly processHost: ProcessHost | undefined;
	readonly plugins: ReadonlyMap<string, PluginHandler>;
	now(): number;
	sleep(untilMs: number, ctx: Context): Promise<void>;
	waitForInput(id: Id, ctx: Context): Promise<Input>;
	waitForTask(id: Id, ctx: Context): Promise<Task>;
	abortTask(id: Id, ctx: Context): Promise<"marked" | "terminal">;
	abortConversation(id: Id, ctx: Context): Promise<void>;
	createOwnedConversation(spec: OwnedConversationSpec, ctx: Context): Promise<Id>;
	/** Admission for a conversation owned by this task; the runtime verifies ownership before invoking the kernel. */
	sendOwned(conversationId: Id, input: SendInput, ctx: Context): Promise<Id>;
	// off-line reads
	context(conversationId: Id, at: Id | undefined, ctx: Context): Promise<ContextView>;
	newestEntry(
		conversationId: Id,
		opts: { kind?: string; withHead?: boolean },
		ctx: Context,
	): Promise<Entry | undefined>;
	rewindable(conversationId: Id, ctx: Context): Promise<RewindableState>;
	sticky(conversationId: Id, ctx: Context): Promise<StickyState>;
	rewindableAsOf(conversationId: Id, at: Id, ctx: Context): Promise<RewindableState | undefined>;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type ToolControl = { terminate?: true; handoff?: string; addTools?: string[] };
export interface ToolDiagnostic {
	severity: "info" | "warn" | "error";
	message: string;
	code?: string;
}
export interface ToolResult {
	/** Omit when the tool streamed through `api.stream`: the bounded stream is the content. */
	content?: (TextContent | ImageContent)[];
	isError?: boolean;
	details?: JsonValue;
	diagnostics?: ToolDiagnostic[];
	control?: ToolControl;
}
export interface ToolDeclaration<P extends TSchema = TSchema> {
	readonly name: string;
	readonly description: string;
	readonly parameters: P;
	readonly replay?: "safe" | "unsafe"; // default unsafe
	readonly output?: { maxBytes?: number; maxLines?: number; retain?: "head" | "tail" };
	execute(args: Static<P>, api: ToolApi, ctx: Context): Promise<ToolResult>;
}
/** Erased declaration held by the registry. */
export type AnyToolDeclaration = ToolDeclaration<TSchema>;

/** The narrow handle a task gets to a conversation it owns. */
export interface OwnedConversation {
	readonly id: Id;
	send(
		input: SendInput,
		ctx: Context,
	): Promise<{ id: Id; wait(ctx: Context): Promise<Input>; result(ctx: Context): Promise<Input | undefined> }>;
	abort(ctx: Context): Promise<void>;
}

export interface BeforeToolApi extends HookApi {
	readonly callId: string;
	waiting(ctx: Context): Promise<void>;
	memo<T extends JsonValue>(name: string, candidate: T, ctx: Context): Promise<T>;
	memo<T extends JsonValue>(name: string, ctx: Context): Promise<T | undefined>;
	emit(name: string, data: JsonValue, ctx: Context): Promise<void>;
}

export interface ToolApi {
	readonly taskId: Id;
	readonly conversationId: Id;
	readonly callId: string;
	/** Pipe raw output here. The kernel bounds it per the declaration, flushes it on a throttle, and uses it as the result content unless the tool returns its own. Synchronous. */
	stream(chunk: string | Uint8Array): void;
	/** Mutate the live slot's free fields (`progress`, `details`, `continuedBy`). Identity fields are protected. */
	progress(
		update: (slot: Pick<ToolSlot, "progress" | "details" | "continuedBy">) => void,
		ctx: Context,
	): Promise<void>;
	memo<T extends JsonValue>(name: string, candidate: T, ctx: Context): Promise<T>;
	memo<T extends JsonValue>(name: string, ctx: Context): Promise<T | undefined>;
	conversation(spec: OwnedConversationSpec, ctx: Context): Promise<OwnedConversation>;
	task<K extends AnyKind>(
		kind: K,
		input: InputOf<K>,
		opts: { background?: true; after?: Id[] },
		ctx: Context,
	): Promise<TaskRef<K>>;
	getTask<K extends AnyKind>(ref: TaskRef<K>, ctx: Context): Promise<TaskOf<K> | undefined>;
	waitForTask<K extends AnyKind>(ref: TaskRef<K>, ctx: Context): Promise<TaskOf<K>>;
	/** Snapshot of another task's live slot (in this task's conversation or subtree). */
	slot<K extends AnyKind>(ref: TaskRef<K>, ctx: Context): Promise<SlotOf<K> | undefined>;
}

export interface ProcessSpec {
	command: string;
	args: string[];
	cwd: string;
	env?: { [key: string]: string };
}
export type ProcessStatus =
	| { status: "running"; stdout: string; stderr: string; droppedStdout: number; droppedStderr: number }
	| {
			status: "exited";
			exitCode: number;
			stdout: string;
			stderr: string;
			droppedStdout: number;
			droppedStderr: number;
	  }
	| { status: "unknown" };
export interface ProcessHost {
	start(key: string, spec: ProcessSpec, ctx: Context): Promise<void>;
	status(key: string, ctx: Context): Promise<ProcessStatus>;
	kill(key: string, signal: "SIGTERM" | "SIGKILL", ctx: Context): Promise<void>;
}

export type PluginHandler = (input: JsonValue, api: ToolApi, ctx: Context) => Promise<JsonValue>;

// ---------------------------------------------------------------------------
// Invocation tokens and invokers
// ---------------------------------------------------------------------------

/** An unforgeable capability: only the scheduler creates these, one per invocation. */
export class InvocationToken {
	#alive = true;
	readonly taskId: Id;
	readonly mode: "run" | "abort";
	constructor(taskId: Id, mode: "run" | "abort") {
		this.taskId = taskId;
		this.mode = mode;
	}
	get alive() {
		return this.#alive;
	}
	/** Called by the scheduler when the invocation returns. */
	revoke() {
		this.#alive = false;
	}
}

export type Invoker =
	| { readonly type: "host"; readonly conversationId?: Id }
	/** Harness internals acting with core authority (send, reset, abort, retire). Never exported. */
	| { readonly type: "kernel"; readonly conversationId?: Id }
	| {
			readonly type: "task";
			readonly token: InvocationToken;
			readonly id: Id;
			readonly conversationId: Id;
			readonly kind: AnyKind;
			readonly core: boolean;
			readonly mode: "run" | "abort";
	  };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class Forbidden extends Error {
	constructor(what: string) {
		super(`forbidden: ${what}`);
		this.name = "Forbidden";
	}
}
export class ConversationBusy extends Error {
	constructor(id: Id) {
		super(`conversation ${id} is busy`);
		this.name = "ConversationBusy";
	}
}
export class GenerationInProgress extends Error {
	constructor(id: Id) {
		super(`conversation ${id} already has a live generation`);
		this.name = "GenerationInProgress";
	}
}
export class CollapseInProgress extends Error {
	constructor(id: Id) {
		super(`conversation ${id} already has a live collapse`);
		this.name = "CollapseInProgress";
	}
}
export class Faulted extends Error {
	constructor(cause: unknown) {
		super(`Session faulted: ${String(cause)}`);
		this.name = "Faulted";
	}
}
export class Closed extends Error {
	constructor() {
		super("Session is closed");
		this.name = "Closed";
	}
}
export class TaskContractFault extends Error {
	constructor(kind: string, what: string) {
		super(`kind ${kind} broke its contract: ${what}`);
		this.name = "TaskContractFault";
	}
}

export type { ToolCall, ToolResultMessage, AssistantMessage, UserMessage, DeferredHandle, ThinkingLevel };
export type RequestMessage = StoredMessage;
