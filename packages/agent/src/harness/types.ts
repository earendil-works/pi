import type { SimpleStreamOptions, Transport } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import type { Context } from "./context.ts";
import type { JsonValue } from "./session/types.ts";
import type { TruncationResult } from "./utils/truncate.ts";

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

/** Options for one live harness tool progress update. */
export interface AgentHarnessToolUpdateOptions {
	/** Request replacement of this invocation's durable recovery checkpoint. */
	checkpoint?: true;
}

/** Synchronous full-snapshot progress callback supplied to harness-native tools. */
export type AgentHarnessToolUpdateCallback<TDetails> = (
	partialResult: AgentToolResult<TDetails>,
	options?: AgentHarnessToolUpdateOptions,
) => void;

/** Stable harness identity for one logical tool call, unchanged during safe replay. */
export interface AgentHarnessToolInvocation {
	/** Opaque session-unique id equal to the call's reserved result-entry id. */
	readonly invocationId: string;
	readonly operationId: string;
	readonly turnId: string;
	/** Read one invocation-scoped durable replay memo. */
	getMemo(name: string): Promise<JsonValue | undefined>;
	/** Set or delete one invocation-scoped durable replay memo. */
	setMemo(name: string, value: JsonValue | undefined): Promise<void>;
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
		onUpdate: AgentHarnessToolUpdateCallback<TDetails>,
		toolContext: TContext,
		invocation: AgentHarnessToolInvocation,
		context: Context,
	): Promise<AgentToolResult<TDetails>>;
};

/** Static tool context or provider resolved for each turn snapshot. */
export type AgentHarnessToolContextSource<TContext extends object | undefined> =
	| TContext
	| ((context: Context) => TContext | Promise<TContext>);

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
	/** Ask a capable provider to continue generation asynchronously. */
	deferred?: boolean | { window?: "15m" | "1h" | "24h" };
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
export type CompactionErrorCode = "aborted" | "summarization_failed";

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
export type BranchSummaryErrorCode = "aborted" | "summarization_failed";

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
	absolutePath(path: string, context: Context): Promise<Result<string, FileError>>;
	/** Join path segments in the filesystem namespace without requiring the result to exist. */
	joinPath(parts: string[], context: Context): Promise<Result<string, FileError>>;
	/** Read a UTF-8 text file. */
	readTextFile(path: string, context: Context): Promise<Result<string, FileError>>;
	/** Read UTF-8 text lines. Implementations should stop once `maxLines` lines have been read. */
	readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>>;
	/** Read a binary file. */
	readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>>;
	/** Create or overwrite a file, creating parent directories when supported. */
	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>>;
	/** Create or append to a file, creating parent directories when supported. */
	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>>;
	/** Atomically rename a file, replacing the destination when it exists. Does not copy across filesystems. */
	renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>>;
	/** Return metadata for the addressed path without following symlinks. */
	fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>>;
	/** List direct children of a directory without following symlinks. */
	listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>>;
	/** Return the canonical path for an existing path, resolving symlinks where supported. */
	canonicalPath(path: string, context: Context): Promise<Result<string, FileError>>;
	/** Return false for missing paths. Other errors, such as permission failures, return a {@link FileError}. */
	exists(path: string, context: Context): Promise<Result<boolean, FileError>>;
	/** Create a directory. Defaults to `recursive: true`. */
	createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>>;
	/** Remove a file or directory. Defaults to `recursive: false` and `force: false`. */
	remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>>;
	/** Create a temporary directory and return its absolute path. Defaults to `prefix: "tmp-"`. */
	createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>>;
	/** Create a temporary file and return its absolute path. Defaults to `prefix: ""` and `suffix: ""`. */
	createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>>;

	/** Release filesystem resources. Must be best-effort and must not throw or reject. */
	cleanup(context: Context): Promise<void>;
}

/** Which portion of bounded output survives after the limit is crossed. */
export type ShellOutputRetention = "head" | "tail";

/** Source-side limits for one combined shell output view. */
export interface ShellOutputLimits {
	maxBytes: number;
	maxLines: number;
	/** Defaults to `"tail"`. */
	retain?: ShellOutputRetention;
}

/** Bounded shell capture requested by the caller. */
export interface ShellOutputCaptureOptions {
	limits: ShellOutputLimits;
	/** Preserve complete output in an execution-environment-local file after the limits are crossed. */
	spill?: boolean;
}

/** Truncation metadata without a duplicate copy of the retained text. */
export type ShellOutputTruncation = Omit<TruncationResult, "content">;

/** Metadata accompanying a bounded shell output view. */
export interface ShellOutputMetadata {
	truncation: ShellOutputTruncation;
	spillPath?: string;
	lastLineBytes?: number;
}

/** Complete bounded shell output view. */
export interface ShellOutputView extends ShellOutputMetadata {
	text: string;
}

/** Incremental source-side change to one bounded shell output view. */
export type ShellOutputUpdate =
	| { kind: "replace"; output: ShellOutputView }
	| { kind: "append"; text: string; metadata: ShellOutputMetadata }
	| { kind: "slide"; drop: number; text: string; metadata: ShellOutputMetadata }
	| { kind: "metadata"; metadata: ShellOutputMetadata };

/** Bounded shell completion. Output text is delivered through {@link ShellExecOptions.onUpdate}. */
export interface ShellExecResult extends ShellOutputMetadata {
	exitCode: number;
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
	/** Source-side bounded capture. Output is discarded when this and `onUpdate` are both absent. */
	capture?: ShellOutputCaptureOptions;
	/** Called with bounded output changes. */
	onUpdate?: (update: ShellOutputUpdate, context: Context) => void;
}

/** Shell execution capability used by the harness. */
export interface Shell {
	/** Execute a shell command in {@link FileSystem.cwd} unless `options.cwd` is provided. */
	exec(
		command: string,
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>>;
	/** Release shell resources. Must be best-effort and must not throw or reject. */
	cleanup(context: Context): Promise<void>;
}

/** Filesystem and process execution environment used by the harness. */
export interface ExecutionEnv extends FileSystem, Shell {}
