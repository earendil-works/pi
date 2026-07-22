import type {
	ImageContent,
	Model,
	Models,
	RetryPolicy,
	SimpleStreamOptions,
	TextContent,
	Transport,
	Usage,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import type {
	AgentEvent,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
	QueueMode,
	ThinkingLevel,
} from "../index.ts";
import type { Session } from "./session/session.ts";

/** Result of a fallible operation. Expected failures are returned as `ok: false` instead of thrown. */
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

/** Create a successful {@link Result}. */
export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
	return { ok: true, value };
}

/** Create a failed {@link Result}. */
export function err<TValue, TError>(error: TError): Result<TValue, TError> {
	return { ok: false, error };
}

/** Return the success value or throw the failure error. Intended for tests and explicit adapter boundaries. */
export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}

/** Return the success value or `undefined`. Only object values are allowed to avoid truthiness bugs with primitives. */
export function getOrUndefined<TValue extends object, TError>(result: Result<TValue, TError>): TValue | undefined {
	return result.ok ? result.value : undefined;
}

/** Normalize unknown thrown values into Error instances before using them as typed error causes. */
export function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	if (typeof error === "string") return new Error(error);
	try {
		return new Error(JSON.stringify(error));
	} catch {
		return new Error(String(error));
	}
}

/**
 * Skill loaded from a `SKILL.md` file or provided by an application.
 *
 * `name`, `description`, and `filePath` are inserted into the system prompt in an XML-formatted block as suggested by agentskills.io.
 * Use {@link formatSkillsForSystemPrompt} to generate the spec-compatible system prompt block.
 */
export interface Skill {
	/** Stable skill name used for lookup and model-visible listings. */
	name: string;
	/** Short model-visible description of when to use the skill. */
	description: string;
	/** Full skill instructions. */
	content: string;
	/** Absolute path to the skill file. Used for model-visible location and resolving relative references. */
	filePath: string;
	/** Exclude this skill from model-visible skill lists while still allowing explicit application invocation. */
	disableModelInvocation?: boolean;
}

/** Prompt template that can be formatted into a prompt for explicit invocation. */
export interface PromptTemplate {
	/** Stable template name used for lookup or application command routing. */
	name: string;
	/** Optional description for command lists or autocomplete. */
	description?: string;
	/** Template content. Argument placeholders are formatted by `formatPromptTemplateInvocation`. */
	content: string;
}

/** Resources made available to explicit invocation methods and system-prompt callbacks. */
export interface AgentHarnessResources<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
	/** Prompt templates available for explicit invocation. */
	promptTemplates?: TPromptTemplate[];
	/** Skills available to the model and explicit skill invocation. */
	skills?: TSkill[];
}

/** Tool definition executed by an {@link AgentHarness} with an application-defined context. */
export type AgentHarnessTool<
	TContext extends object | undefined,
	TParameters extends TSchema = TSchema,
	TDetails = unknown,
> = Omit<AgentTool<TParameters, TDetails>, "execute"> & {
	/** Execute the tool call with the context resolved for the current turn snapshot. */
	execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		context: TContext,
	): Promise<AgentToolResult<TDetails>>;
};

/** Static tool context or zero-argument provider resolved for each turn snapshot. */
export type AgentHarnessToolContextSource<TContext extends object | undefined> =
	| TContext
	| (() => TContext | Promise<TContext>);

/** Curated provider request options owned by the harness and snapshotted per turn. */
export interface AgentHarnessStreamOptions {
	/** Preferred transport forwarded to the stream function. */
	transport?: Transport;
	/** Provider request timeout in milliseconds. */
	timeoutMs?: number;
	/** Maximum provider retry attempts. */
	maxRetries?: number;
	/** Optional cap for provider-requested retry delays. */
	maxRetryDelayMs?: number;
	/** Additional request headers merged with auth and lifecycle headers. */
	headers?: Record<string, string>;
	/** Provider metadata forwarded with requests. */
	metadata?: SimpleStreamOptions["metadata"];
	/** Provider cache retention hint. */
	cacheRetention?: SimpleStreamOptions["cacheRetention"];
}

/** Per-request stream option patch returned by provider hooks. */
export interface AgentHarnessStreamOptionsPatch
	extends Omit<Partial<AgentHarnessStreamOptions>, "headers" | "metadata"> {
	/** Header patch. `undefined` values delete keys; explicit `headers: undefined` clears all headers. */
	headers?: Record<string, string | undefined>;
	/** Metadata patch. `undefined` values delete keys; explicit `metadata: undefined` clears all metadata. */
	metadata?: Record<string, unknown | undefined>;
}

/** Kind of filesystem object as addressed by a {@link FileSystem}. Symlinks are not followed automatically. */
export type FileKind = "file" | "directory" | "symlink";

/** Stable, backend-independent file error codes returned by {@link FileSystem} file operations. */
export type FileErrorCode =
	| "aborted"
	| "not_found"
	| "permission_denied"
	| "not_directory"
	| "is_directory"
	| "invalid"
	| "not_supported"
	| "unknown";

/** Error returned by {@link FileSystem} file operations. */
export class FileError extends Error {
	/** Backend-independent error code. */
	public code: FileErrorCode;
	/** Absolute addressed path associated with the failure, when available. */
	public path?: string;

	constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "FileError";
		this.code = code;
		this.path = path;
	}
}

/** Stable, backend-independent execution error codes returned by {@link ExecutionEnv.exec}. */
export type ExecutionErrorCode =
	| "aborted"
	| "timeout"
	| "shell_unavailable"
	| "spawn_error"
	| "callback_error"
	| "unknown";

/** Error returned by {@link ExecutionEnv.exec}. */
export class ExecutionError extends Error {
	/** Backend-independent error code. */
	public code: ExecutionErrorCode;

	constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ExecutionError";
		this.code = code;
	}
}

/** Stable compaction error codes returned by compaction helpers. */
export type CompactionErrorCode = "aborted" | "summarization_failed" | "invalid_session" | "unknown";

/** Error returned by compaction helpers. */
export class CompactionError extends Error {
	/** Backend-independent error code. */
	public code: CompactionErrorCode;

	constructor(code: CompactionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "CompactionError";
		this.code = code;
	}
}

/** Stable branch-summary error codes returned by branch summarization helpers. */
export type BranchSummaryErrorCode = "aborted" | "summarization_failed" | "invalid_session";

/** Error returned by branch summarization helpers. */
export class BranchSummaryError extends Error {
	/** Backend-independent error code. */
	public code: BranchSummaryErrorCode;

	constructor(code: BranchSummaryErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "BranchSummaryError";
		this.code = code;
	}
}

export type SessionErrorCode =
	| "not_found"
	| "invalid_session"
	| "invalid_entry"
	| "invalid_fork_target"
	| "storage"
	| "unknown";

/** Error thrown by session storage, repositories, and session tree operations. */
export class SessionError extends Error {
	/** Session subsystem error code. */
	public code: SessionErrorCode;

	constructor(code: SessionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SessionError";
		this.code = code;
	}
}

export type AgentHarnessErrorCode =
	| "busy"
	| "invalid_state"
	| "invalid_argument"
	| "session"
	| "hook"
	| "auth"
	| "compaction"
	| "branch_summary"
	| "unknown";

/** Public AgentHarness failure with a stable top-level classification. */
export class AgentHarnessError extends Error {
	public code: AgentHarnessErrorCode;

	constructor(code: AgentHarnessErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "AgentHarnessError";
		this.code = code;
	}
}

/** Metadata for one filesystem object in a {@link FileSystem}. */
export interface FileInfo {
	/** Basename of {@link path}. */
	name: string;
	/** Absolute, syntactically normalized addressed path in the execution environment. Symlinks are not followed. */
	path: string;
	/** Object kind. Symlink targets are not followed; use {@link FileSystem.canonicalPath} explicitly. */
	kind: FileKind;
	/** Size in bytes for the addressed filesystem object. */
	size: number;
	/** Modification time as milliseconds since Unix epoch. */
	mtimeMs: number;
}

/**
 * Filesystem capability used by the harness.
 *
 * Paths passed to methods may be absolute or relative to {@link cwd}. Paths returned by file operations are addressed paths
 * in the filesystem namespace, but are not canonicalized through symlinks unless returned by {@link canonicalPath}.
 *
 * Operation methods must never throw or reject. All filesystem failures, including unexpected backend failures, must be
 * encoded in the returned {@link Result}. Implementations must preserve this invariant.
 */
export interface FileSystem {
	/** Current working directory for relative paths. */
	cwd: string;

	/** Return an absolute addressed path without requiring it to exist and without resolving symlinks. */
	absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** Join path segments in the filesystem namespace without requiring the result to exist. */
	joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** Read a UTF-8 text file. */
	readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** Read UTF-8 text lines. Implementations should stop once `maxLines` lines have been read. */
	readTextLines(
		path: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
	): Promise<Result<string[], FileError>>;
	/** Read a binary file. */
	readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>>;
	/** Create or overwrite a file, creating parent directories when supported. */
	writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
	/** Create or append to a file, creating parent directories when supported. */
	appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
	/** Return metadata for the addressed path without following symlinks. */
	fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>>;
	/** List direct children of a directory without following symlinks. */
	listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>>;
	/** Return the canonical path for an existing path, resolving symlinks where supported. */
	canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** Return false for missing paths. Other errors, such as permission failures, return a {@link FileError}. */
	exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>>;
	/** Create a directory. Defaults: `recursive: true`, no abort signal. */
	createDir(
		path: string,
		options?: { recursive?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>>;
	/** Remove a file or directory. Defaults: `recursive: false`, `force: false`, no abort signal. */
	remove(
		path: string,
		options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>>;
	/** Create a temporary directory and return its absolute path. Defaults: `prefix: "tmp-"`, no abort signal. */
	createTempDir(prefix?: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** Create a temporary file and return its absolute path. Defaults: `prefix: ""`, `suffix: ""`, no abort signal. */
	createTempFile(options?: {
		prefix?: string;
		suffix?: string;
		abortSignal?: AbortSignal;
	}): Promise<Result<string, FileError>>;

	/** Release filesystem resources. Must be best-effort and must not throw or reject. */
	cleanup(): Promise<void>;
}

/** Options for {@link Shell.exec}. */
export interface ShellExecOptions {
	/** Working directory for the command. Relative paths are resolved against {@link ExecutionEnv.cwd}. Defaults to {@link ExecutionEnv.cwd}. */
	cwd?: string;
	/** Environment variables for the command. Values override inherited defaults when `inheritEnv` is true. */
	env?: Record<string, string>;
	/** Whether to inherit the execution environment's default variables. Defaults to true. */
	inheritEnv?: boolean;
	/** Timeout in seconds. Implementations should return a timeout error when the command exceeds this duration. Defaults to no timeout. */
	timeout?: number;
	/** Abort signal used to terminate the command. Defaults to no abort signal. */
	abortSignal?: AbortSignal;
	/** Called with stdout chunks as they are produced. */
	onStdout?: (chunk: string) => void;
	/** Called with stderr chunks as they are produced. */
	onStderr?: (chunk: string) => void;
}

/** Shell execution capability used by the harness. */
export interface Shell {
	/** Execute a shell command in {@link FileSystem.cwd} unless `options.cwd` is provided. */
	exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>>;
	/** Release shell resources. Must be best-effort and must not throw or reject. */
	cleanup(): Promise<void>;
}

/** Filesystem and process execution environment used by the harness. */
export interface ExecutionEnv extends FileSystem, Shell {}

export interface SessionTreeEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface MessageEntry extends SessionTreeEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionTreeEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionTreeEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface ActiveToolsChangeEntry extends SessionTreeEntryBase {
	type: "active_tools_change";
	activeToolNames: string[];
}

export interface CompactionEntry<T = unknown> extends SessionTreeEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId?: string;
	tokensBefore: number;
	retainedTail?: AgentMessage[];
	details?: T;
	usage?: Usage;
	fromHook?: boolean;
}

export interface BranchSummaryEntry<T = unknown> extends SessionTreeEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: T;
	usage?: Usage;
	fromHook?: boolean;
}

export interface CustomEntry<T = unknown> extends SessionTreeEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

export interface CustomMessageEntry<T = unknown> extends SessionTreeEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

export interface LabelEntry extends SessionTreeEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

export interface SessionInfoEntry extends SessionTreeEntryBase {
	type: "session_info"; // legacy name, kept for backwards compatibility
	name?: string;
}

export interface LeafEntry extends SessionTreeEntryBase {
	type: "leaf";
	targetId: string | null;
}

export type SessionTreeEntry =
	| MessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| ActiveToolsChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry
	| LeafEntry;

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
	activeToolNames: string[] | null;
}

export interface SessionStats {
	messageCount: number;
	cachedTokens: number;
	uncachedTokens: number;
	totalTokens: number;
	costTotal: number;
}

export interface SessionMetadata {
	id: string;
	createdAt: string;
}

export interface JsonlSessionMetadata extends SessionMetadata {
	cwd: string;
	path: string;
	parentSessionPath?: string;
	metadata?: Record<string, unknown>;
}

export interface SessionEntryCursorOptions {
	afterEntrySeq?: number;
	limit?: number;
}

export interface SessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
	getMetadata(): Promise<TMetadata>;
	getLeafId(): Promise<string | null>;
	/** Persist a leaf entry that records the active session-tree leaf. */
	setLeafId(leafId: string | null): Promise<void>;
	createEntryId(): Promise<string>;
	appendEntry(entry: SessionTreeEntry): Promise<void>;
	getEntry(id: string): Promise<SessionTreeEntry | undefined>;
	findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>>;
	getLabel(id: string): Promise<string | undefined>;
	getSessionName(): Promise<string | undefined>;
	getSessionStats(): Promise<SessionStats>;
	getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]>;
	getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]>;
}

export type { Session } from "./session/session.ts";

export interface SessionCreateOptions {
	id?: string;
}

export interface SessionForkOptions {
	entryId?: string;
	position?: "before" | "at";
	id?: string;
}

export interface SessionRepo<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> {
	create(options: TCreateOptions): Promise<Session<TMetadata>>;
	open(metadata: TMetadata): Promise<Session<TMetadata>>;
	list(options?: TListOptions): Promise<TMetadata[]>;
	delete(metadata: TMetadata): Promise<void>;
	fork(source: TMetadata, options: SessionForkOptions & TCreateOptions): Promise<Session<TMetadata>>;
}

export interface JsonlSessionCreateOptions extends SessionCreateOptions {
	cwd: string;
	parentSessionPath?: string;
	metadata?: Record<string, unknown>;
}

export interface JsonlSessionListOptions {
	cwd?: string;
}

export interface JsonlSessionRepoApi
	extends SessionRepo<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions> {}

export type AgentHarnessPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";

export type PendingSessionWrite = SessionTreeEntry extends infer TEntry
	? TEntry extends SessionTreeEntry
		? Omit<TEntry, "id" | "parentId" | "timestamp">
		: never
	: never;

export interface QueueUpdateEvent {
	type: "queue_update";
	steer: AgentMessage[];
	followUp: AgentMessage[];
	nextTurn: AgentMessage[];
}

export interface SavePointEvent {
	type: "save_point";
	hadPendingMutations: boolean;
}

export interface AbortEvent {
	type: "abort";
	clearedSteer: AgentMessage[];
	clearedFollowUp: AgentMessage[];
}

export interface SettledEvent {
	type: "settled";
	nextTurnCount: number;
}

export interface BeforeAgentStartEvent<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
	type: "before_agent_start";
	prompt: string;
	images?: ImageContent[];
	systemPrompt: string;
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
}

export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	model: Model<any>;
	sessionId: string;
	streamOptions: AgentHarnessStreamOptions;
}

export interface BeforeProviderPayloadEvent {
	type: "before_provider_payload";
	model: Model<any>;
	payload: unknown;
}

export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	status: number;
	headers: Record<string, string>;
}

export interface ToolCallEvent {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}

export interface ToolResultEvent {
	type: "tool_result";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	content: Array<TextContent | ImageContent>;
	details: unknown;
	isError: boolean;
	usage?: Usage;
}

export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
	branchEntries: SessionTreeEntry[];
	customInstructions?: string;
	signal: AbortSignal;
}

export interface SessionCompactEvent {
	type: "session_compact";
	compactionEntry: CompactionEntry;
	fromHook: boolean;
}

export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	preparation: TreePreparation;
	signal: AbortSignal;
}

export interface SessionTreeEvent {
	type: "session_tree";
	newLeafId: string | null;
	oldLeafId: string | null;
	summaryEntry?: BranchSummaryEntry;
	fromHook?: boolean;
}

export interface RetryScheduledEvent {
	type: "retry_scheduled";
	operation: "compaction" | "branch_summary";
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}

export interface RetryAttemptStartEvent {
	type: "retry_attempt_start";
	operation: "compaction" | "branch_summary";
}

export interface RetryFinishedEvent {
	type: "retry_finished";
	operation: "compaction" | "branch_summary";
}

export interface ModelUpdateEvent {
	type: "model_update";
	model: Model<any>;
	previousModel: Model<any> | undefined;
	source: "set" | "restore";
}

export interface ThinkingLevelUpdateEvent {
	type: "thinking_level_update";
	level: ThinkingLevel;
	previousLevel: ThinkingLevel;
}

export interface ToolsUpdateEvent {
	type: "tools_update";
	toolNames: string[];
	previousToolNames: string[];
	activeToolNames: string[];
	previousActiveToolNames: string[];
	source: "set" | "restore";
}

export interface ResourcesUpdateEvent<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
	type: "resources_update";
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	previousResources: AgentHarnessResources<TSkill, TPromptTemplate>;
}

export type AgentHarnessOwnEvent<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> =
	| QueueUpdateEvent
	| SavePointEvent
	| AbortEvent
	| SettledEvent
	| BeforeAgentStartEvent<TSkill, TPromptTemplate>
	| ContextEvent
	| BeforeProviderRequestEvent
	| BeforeProviderPayloadEvent
	| AfterProviderResponseEvent
	| ToolCallEvent
	| ToolResultEvent
	| SessionBeforeCompactEvent
	| SessionCompactEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent
	| RetryScheduledEvent
	| RetryAttemptStartEvent
	| RetryFinishedEvent
	| ModelUpdateEvent
	| ThinkingLevelUpdateEvent
	| ResourcesUpdateEvent<TSkill, TPromptTemplate>
	| ToolsUpdateEvent;

export type AgentHarnessEvent<TSkill extends Skill = Skill, TPromptTemplate extends PromptTemplate = PromptTemplate> =
	| AgentEvent
	| AgentHarnessOwnEvent<TSkill, TPromptTemplate>;

export interface BeforeAgentStartResult {
	messages?: AgentMessage[];
	systemPrompt?: string;
}

export interface ContextResult {
	messages: AgentMessage[];
}

export interface BeforeProviderRequestResult {
	streamOptions?: AgentHarnessStreamOptionsPatch;
}

export interface BeforeProviderPayloadResult {
	payload: unknown;
}

export interface ToolCallResult {
	block?: boolean;
	reason?: string;
}

export interface ToolResultPatch {
	content?: Array<TextContent | ImageContent>;
	details?: unknown;
	isError?: boolean;
	usage?: Usage;
	terminate?: boolean;
}

export interface SessionBeforeCompactResult {
	cancel?: boolean;
	compaction?: CompactResult;
}

export interface SessionBeforeTreeResult {
	cancel?: boolean;
	summary?: {
		summary: string;
		details?: unknown;
		/** Usage from the LLM call that generated this summary, if available. */
		usage?: Usage;
	};
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

export type AgentHarnessEventResultMap = {
	before_agent_start: BeforeAgentStartResult | undefined;
	context: ContextResult | undefined;
	before_provider_request: BeforeProviderRequestResult | undefined;
	before_provider_payload: BeforeProviderPayloadResult | undefined;
	after_provider_response: undefined;
	tool_call: ToolCallResult | undefined;
	tool_result: ToolResultPatch | undefined;
	session_before_compact: SessionBeforeCompactResult | undefined;
	session_compact: undefined;
	session_before_tree: SessionBeforeTreeResult | undefined;
	session_tree: undefined;
	retry_scheduled: undefined;
	retry_attempt_start: undefined;
	retry_finished: undefined;
	model_update: undefined;
	thinking_level_update: undefined;
	resources_update: undefined;
	tools_update: undefined;
	queue_update: undefined;
	save_point: undefined;
	abort: undefined;
	settled: undefined;
};

export interface AgentHarnessPromptOptions {
	images?: ImageContent[];
}

export interface AbortResult {
	clearedSteer: AgentMessage[];
	clearedFollowUp: AgentMessage[];
}

export interface CompactResult {
	summary: string;
	firstKeptEntryId?: string;
	tokensBefore: number;
	/** Usage from the LLM call(s) that generated this summary, if available. */
	usage?: Usage;
	retainedTail?: AgentMessage[];
	details?: unknown;
}

export interface NavigateTreeResult {
	cancelled: boolean;
	editorText?: string;
	summaryEntry?: BranchSummaryEntry;
}

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface CompactionPreparation {
	firstKeptEntryId: string;
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	retainedTail: AgentMessage[];
	isSplitTurn: boolean;
	tokensBefore: number;
	previousSummary?: string;
	fileOps: FileOperations;
	settings: CompactionSettings;
}

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export interface TreePreparation {
	targetId: string;
	oldLeafId: string | null;
	commonAncestorId: string | null;
	entriesToSummarize: SessionTreeEntry[];
	userWantsSummary: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

export interface GenerateBranchSummaryOptions {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	signal: AbortSignal;
	customInstructions?: string;
	replaceInstructions?: boolean;
	reserveTokens?: number;
}

export interface BranchSummaryResult {
	summary: string;
	usage?: Usage;
	readFiles: string[];
	modifiedFiles: string[];
}

export type AgentHarnessSystemPrompt<
	TContext extends object | undefined = undefined,
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentHarnessTool<TContext> = AgentHarnessTool<TContext>,
> =
	| string
	| ((context: {
			session: Session;
			model: Model<any>;
			thinkingLevel: ThinkingLevel;
			activeTools: TTool[];
			resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	  }) => string | Promise<string>);

interface AgentHarnessOptionsBase<
	TContext extends object | undefined,
	TSkill extends Skill,
	TPromptTemplate extends PromptTemplate,
	TTool extends AgentHarnessTool<TContext>,
> {
	session: Session;
	/**
	 * Provider collection used for all model requests (turn streaming,
	 * compaction, branch summarization). Auth resolves through the providers'
	 * auth.
	 */
	models: Models;
	tools?: TTool[];
	/**
	 * Concrete resources available to explicit invocation methods and system-prompt callbacks.
	 * Applications own loading/reloading resources and should call `setResources()` with new values.
	 */
	resources?: AgentHarnessResources<TSkill, TPromptTemplate>;
	systemPrompt?: AgentHarnessSystemPrompt<TContext, TSkill, TPromptTemplate, TTool>;
	/** Curated stream/provider request options. Snapshotted at turn start. */
	streamOptions?: AgentHarnessStreamOptions;
	/** Optional retry policy for generated compaction and branch-summary requests. */
	retry?: RetryPolicy;
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
	activeToolNames?: string[];
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
}

export type AgentHarnessOptions<
	TContext extends object | undefined = undefined,
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentHarnessTool<TContext> = AgentHarnessTool<TContext>,
> = AgentHarnessOptionsBase<TContext, TSkill, TPromptTemplate, TTool> &
	([TContext] extends [undefined]
		? {
				/** Context-free harnesses do not need a tool context. */
				toolContext?: undefined;
			}
		: {
				/** Static context or zero-argument context provider resolved for each turn snapshot. */
				toolContext: AgentHarnessToolContextSource<TContext>;
			});

export type { AgentHarness } from "./agent-harness.ts";
