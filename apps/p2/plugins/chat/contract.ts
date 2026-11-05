import type { ConversationView } from "@earendil-works/pi-durable";
import { arr, bool, int, nul, num, obj, opt, type Static, str, union, unknown } from "@earendil-works/pi-schema";
import type { Author, Ctx } from "@p2/app/v1";
import {
	AttachmentSchema,
	EntriesPageSchema,
	EntriesQuerySchema,
	keyedRegistry,
	literal,
	local,
	MAX_ATTACHMENTS,
	ModelRefSchema,
	method,
	param,
	propertiesOf,
	remote,
	sessionHost,
	ThinkingLevelSchema,
	unsafe,
} from "@p2/app/v1";
import type { ActiveStats } from "@p2/app/v1/worker";

/**
 * Durable's conversation view as clients hold it: a window over the transcript (the newest 50 to 100 entries, `before`
 * the entry just before it) and the conversation's documents; null until the watch delivered it. Clients render it
 * through `ConversationTranscript`, which pages in what lies before the window or in a gap (`Chat.entries`).
 */
export const ViewSchema = unsafe<ConversationView | null>(unknown());

/** Numbers about the conversation's active context, which the window does not hold; null until computed. */
export const StatsSchema = unsafe<ActiveStats | null>(unknown());

/** One response's cost, for the cost sheet (`Chat.costs`). */
export const AssistantCostSchema = obj({
	entryId: str(),
	timestamp: num(),
	cost: num(),
	/** Absent when the response reported no prompt tokens. */
	cacheHit: opt(num()),
	provider: str(),
	model: str(),
	stopReason: str(),
});

const AuthorSchema = obj({
	kind: union([literal("owner"), literal("guest")]),
	id: str(),
	name: str(),
});

export const SendSchema = obj({
	text: str({ maxLength: 1_000_000 }),
	/** Client-chosen; a retried send with the same ID is admitted once (scoped to the author). */
	requestId: str({ minLength: 1, maxLength: 200 }),
	/** While the conversation is busy: steer the current run (default) or queue a follow-up. */
	whenBusy: opt(union([literal("steer"), literal("followUp")])),
	/** Upload IDs (POST /upload) of this session. */
	attachments: opt(arr(str(), { maxItems: MAX_ATTACHMENTS })),
	/**
	 * The entry of this conversation the message answers. Only a router uses it (chat-mode, in chat mode); it checks
	 * the entry and derives whom it quotes. Ordinary inputs ignore it.
	 */
	replyTo: opt(int({ minimum: 1 })),
});

export {
	type EntriesPage,
	EntriesPageSchema,
	EntriesQuerySchema,
	MAX_ENTRIES_PAGE,
} from "@p2/app/v1";

/** What `Chat.configure` takes: a known thinking level (version 2). */
export const ConfigureSchema = obj({
	model: opt(ModelRefSchema),
	thinkingLevel: opt(ThinkingLevelSchema),
});
/** The worker-internal form (`Conversation.configure`): Chat validated it already. */
const ConversationConfigureSchema = obj({
	model: opt(ModelRefSchema),
	thinkingLevel: opt(str()),
});

const RestoredSchema = arr(obj({ author: AuthorSchema, text: str() }));

/**
 * The conversation's user shell command (`!cmd`/`!!cmd`) while it runs and until its `p2.shell` entry is placed:
 * the tail of its output (src/runtime/shell.ts limits). Null when none.
 */
export const ShellStateSchema = union([
	obj({
		id: str(),
		command: str(),
		author: AuthorSchema,
		includeInContext: bool(),
		output: str(),
		truncated: bool(),
		running: bool(),
		exitCode: opt(num()),
		cancelled: bool(),
		error: opt(str()),
	}),
	nul(),
]);
export type ShellState = Static<typeof ShellStateSchema>;
/** pi's text when a second command is started while one runs (interactive-mode `isBashRunning`). */
export const SHELL_BUSY = "A bash command is already running. Press Esc to cancel it first.";
export const ShellSchema = obj({
	command: str({ minLength: 1, maxLength: 100_000 }),
	/** `!` (true): the output joins the agent's context; `!!` (false): display only. */
	includeInContext: bool(),
	/** Client-chosen; a retried call with the same ID runs once (scoped to the author). */
	requestId: str({ minLength: 1, maxLength: 200 }),
});

/**
 * The conversation's current model as anyone who may view it sees it (guest-safe: no credentials, no catalog): what
 * a footer needs for the context percentage and a picker for the thinking levels. Null without a model, or when the
 * model is not in the server's catalog.
 */
export const ModelMetaSchema = obj({
	provider: str(),
	modelId: str(),
	name: str(),
	contextWindow: num(),
	reasoning: bool(),
	thinkingLevels: arr(str()),
});
export type ModelMeta = Static<typeof ModelMetaSchema>;
const ModelStateSchema = union([ModelMetaSchema, nul()]);

export const CompactSchema = obj({
	/** Extra instructions for the summary (`/compact <instructions>`). */
	instructions: opt(str({ maxLength: 10_000 })),
});
export const ResetSchema = obj({
	/** Text the new context starts with (a handoff note), as a user message. */
	handoff: opt(str({ maxLength: 100_000 })),
});
/** `dequeueOwn`: the caller's queued texts in submission order, and how many of theirs raced (placed or withdrawn). */
export const DequeueOwnResultSchema = obj({
	restored: arr(str()),
	skipped: int({ minimum: 0 }),
});

/**
 * An input as `Conversation.submit` takes it: the text the model reads, who wrote it, and its resolved attachments.
 * It is placed as its own entry: `entry`, or by default a `p2.input` entry whose data is the author, the text and the
 * attachments (see src/runtime/input.ts). The model message also starts with the author's sender block.
 */
export const SubmitSchema = obj({
	...propertiesOf(SendSchema),
	author: AuthorSchema,
	/** The input's own entry kind and data, for a plugin's inputs (chat-mode's `chat.mention`). */
	entry: opt(obj({ kind: str({ minLength: 1 }), data: unknown() })),
	/** Resolved attachments: listed by path, images also inline when the model accepts them. */
	files: opt(arr(AttachmentSchema)),
	/** Inline at most this many images: the last ones of `files` (default: all that qualify). */
	maxImages: opt(int({ minimum: 0 })),
});
export type Submit = Static<typeof SubmitSchema>;

/**
 * One Durable conversation of this worker (host-internal, shared by every viewer): its view mirrored from a Durable
 * watch, and the operations that need an author, which callers pass explicitly.
 */
export const Conversation = local("p2.conversation", {
	version: 1,
	params: { conversation: param.int() },
	members: {
		/** The view's window, as every viewer holds it. */
		view: ViewSchema,
		/** The active context's numbers. */
		stats: StatsSchema,
		/** Each response of the active range with its cost. */
		costs: method(undefined, arr(AssistantCostSchema)),
		submit: method(SubmitSchema, obj({ submissionId: num() })),
		/**
		 * Appends a display-only entry (no model message) through a Durable write submission: placed at once when idle,
		 * at the run's next boundary when busy. A retried `requestId` is admitted once per author.
		 */
		write: method(
			obj({
				kind: str({ minLength: 1 }),
				data: unknown(),
				requestId: str({ minLength: 1, maxLength: 200 }),
				author: AuthorSchema,
			}),
			obj({ submissionId: num() }),
		),
		stop: method(undefined, obj({ restored: RestoredSchema })),
		dequeue: method(obj({ submissionId: num(), restore: bool() }), obj({ restored: RestoredSchema })),
		entries: method(EntriesQuerySchema, EntriesPageSchema),
		configure: method(ConversationConfigureSchema),
		/** The current model's metadata (see `ModelMetaSchema`), following the view's `pi.agent` and the catalog. */
		model: ModelStateSchema,
		/** Admits a manual compaction task (Durable `Conversation.compact`). */
		compact: method(CompactSchema, obj({ taskId: num() })),
		/** Starts a new context (Durable `Conversation.reset`), placed at the next boundary while busy. */
		reset: method(ResetSchema),
		/** Aborts this conversation's live compaction tasks; returns how many were marked. */
		abortCompaction: method(undefined, obj({ aborted: int({ minimum: 0 }) })),
		/** Withdraws `authorId`'s queued inputs (by the server-stamped author) in submission order. */
		dequeueOwn: method(obj({ authorId: str() }), obj({ restored: RestoredSchema, skipped: int({ minimum: 0 }) })),
		/** The running (or just finished, not yet placed) user shell command. */
		shell: ShellStateSchema,
		/** Runs a user shell command on the conversation's environment; one at a time per conversation. */
		runShell: method(obj({ ...propertiesOf(ShellSchema), author: AuthorSchema }), obj({ shellId: str() })),
		/** Cancels the running command `shellId`; false when it is not the running one. */
		abortShell: method(obj({ shellId: str() }), obj({ aborted: bool() })),
	},
});

/**
 * A conversation as a principal sees it: viewers read, participants also send, stop and configure (owner), compact,
 * abort compaction, restore their own queued inputs and (owner) reset the context.
 */
export const Chat = remote("p2.chat", {
	/**
	 * 2: `configure` takes only known thinking levels; `send` refuses blank text without attachments.
	 * 3: `model` state; `compact`, `abortCompaction`, `reset` and `dequeueOwn`.
	 * 4: `liveShell` state; `shell` and `abortShell` (user shell commands, `!cmd`/`!!cmd`).
	 * 5: `view` holds the newest entries only (`ChatView.window`; older ones through `history`).
	 * 6: `view` is Durable's window over the transcript (`before`); `stats` state; `entries` replaces `history`.
	 */
	version: 6,
	params: { session: param.str(), conversation: param.int() },
	hostAddress: sessionHost,
	variants: {
		viewer: {
			state: { view: ViewSchema, stats: StatsSchema, model: ModelStateSchema, liveShell: ShellStateSchema },
			methods: { entries: method(EntriesQuerySchema, EntriesPageSchema) },
		},
		participant: {
			state: { view: ViewSchema, stats: StatsSchema, model: ModelStateSchema, liveShell: ShellStateSchema },
			methods: {
				entries: method(EntriesQuerySchema, EntriesPageSchema),
				send: method(SendSchema, obj({ submissionId: num() })),
				/** Aborts the current run; queued inputs are withdrawn and the caller's own come back as text. */
				stop: method(undefined, obj({ restored: arr(str()) })),
				/** Withdraws a queued input; with `restore`, returns its text if the caller wrote it. */
				dequeue: method(obj({ submissionId: num(), restore: opt(bool()) }), obj({ text: union([str(), nul()]) })),
				configure: method(ConfigureSchema),
				/** Summarizes earlier context now (pi's `/compact [instructions]`); returns the compaction task. */
				compact: method(CompactSchema, obj({ taskId: num() })),
				/** Aborts running compactions (pi: Escape while compacting); returns how many were marked. */
				abortCompaction: method(undefined, obj({ aborted: int({ minimum: 0 }) })),
				/** Starts a new context with an optional handoff (owner only: it changes the context for everyone). */
				reset: method(ResetSchema),
				/**
				 * Withdraws the caller's own queued inputs (by the server-stamped author, in submission order) and returns
				 * their texts; other authors' stay queued. Inputs placed or withdrawn concurrently are counted as skipped.
				 */
				dequeueOwn: method(undefined, DequeueOwnResultSchema),
				/**
				 * Runs a shell command in this conversation's working directory on the session's environment (pi's `!cmd`;
				 * `!!cmd` without context). It never starts a run: the finished command becomes a `p2.shell` entry. One
				 * command at a time per conversation.
				 */
				shell: method(ShellSchema, obj({ shellId: str() })),
				/** Cancels the running command (its author or the owner). */
				abortShell: method(obj({ shellId: str() }), obj({ aborted: bool() })),
			},
		},
	},
});

/**
 * Each response of a conversation's active range with its cost, for whoever may view it (the cost sheet: a client's
 * view holds only a window).
 */
export const ChatCosts = remote("p2.chat-costs", {
	version: 1,
	params: { session: param.str(), conversation: param.int() },
	hostAddress: sessionHost,
	variants: {
		viewer: { methods: { costs: method(undefined, arr(AssistantCostSchema)) } },
	},
});

/** What a participant sent, with the server-stamped author, as `Chat.send` hands it to a router. */
export type RoutedSend = Omit<Static<typeof SendSchema>, "attachments"> & {
	readonly conversation: number;
	readonly author: Author;
	readonly attachments: readonly string[];
};

/**
 * Worker extension point of `Chat.send`: each router may take a message (returning its submission) or leave it
 * (`undefined`). Untaken messages become ordinary inputs. Example: chat-mode writes chat entries.
 */
export const SendRouters =
	keyedRegistry<(input: RoutedSend, ctx: Ctx) => Promise<{ submissionId: number } | undefined>>(
		"p2.chat-send-routers",
	);

/** What a plugin adds to the display of its entry kind's messages: the message it answers, and a short note. */
export type EntryDisplay = {
	readonly replyTo?: { readonly entryId: number; readonly name: string; readonly excerpt: string };
	readonly note?: string;
};

/**
 * Browser extension point of the transcript, keyed by entry kind (e.g. `chat.mention`). The transcript shows every
 * entry whose data is a person's message by itself; a registered kind adds to it.
 */
export const TranscriptEntries =
	keyedRegistry<(data: unknown) => EntryDisplay | undefined>("p2.chat-transcript-entries");
