import { bool, int, num, obj, opt, str, union, unknown } from "@earendil-works/pi-schema";
import { LocationSchema, literal, local, method, param, remote, sessionHost, unsafe } from "@p2/app/v1";
import type { WorkspaceBytes, WorkspaceResult } from "./protocol.ts";

const Path = str({ maxLength: 4096 });
const Commit = str({ pattern: "^[0-9a-f]{7,64}$" });
export const QuerySchema = union([
	obj({ kind: literal("list"), path: Path }),
	/** `commit`: the file as of that commit instead of the working tree. */
	obj({ kind: literal("file"), path: Path, commit: opt(Commit) }),
	/** Every file path below the root, for filtering by name: tracked and untracked, without ignored ones. */
	obj({ kind: literal("files") }),
	obj({ kind: literal("status") }),
	/**
	 * Literal text search below `path` ("" = everywhere), skipping ignored files.
	 * `include`/`exclude`: comma-separated file globs relative to `path`; see `workspaceGlobs`.
	 */
	obj({
		kind: literal("search"),
		path: Path,
		text: str({ minLength: 1, maxLength: 200 }),
		include: opt(str({ maxLength: 500 })),
		exclude: opt(str({ maxLength: 500 })),
	}),
	/** `context`: unchanged lines around each change (default 3); `full` makes the patch the whole file. */
	obj({
		kind: literal("diff"),
		path: Path,
		full: opt(bool()),
		context: opt(int({ minimum: 0, maximum: 1000 })),
		commit: opt(Commit),
	}),
	/** The current branch's history, newest first. */
	obj({
		kind: literal("log"),
		skip: int({ minimum: 0, maximum: 100000 }),
		limit: int({ minimum: 1, maximum: 500 }),
	}),
	/** One commit's message and changed files. */
	obj({ kind: literal("commit"), commit: Commit }),
	/** Where the workspace is open now, and the session's waiting or failed move. */
	obj({ kind: literal("place") }),
]);
const Input = { session: param.str(), conversation: param.int({ min: 1 }) };
const Result = unsafe<WorkspaceResult>(unknown());
const Read = obj({
	path: Path,
	start: opt(int({ minimum: 0 })),
	end: opt(int({ minimum: 0 })),
	suffix: opt(int({ minimum: 1 })),
});
/** One chunk of an upload into a workspace folder; chunks arrive in order. */
export const WriteSchema = obj({
	path: Path,
	name: str({ minLength: 1, maxLength: 255 }),
	token: str({ pattern: "^[0-9a-f-]{36}$" }),
	offset: int({ minimum: 0 }),
	data: str({ maxLength: 1400000 }),
	final: bool(),
	abort: opt(bool()),
});

/** Upload writes serialize across conversations, through the environment at the conversation's location. */
export const WorkspaceWrites = local("p2.workspace-writes", {
	// 3: a location (environment and cwd) instead of a cwd on the session's machine.
	version: 3,
	params: {},
	members: { write: method(obj({ location: LocationSchema, upload: WriteSchema })) },
});

/** Shared worker implementation, one environment (at the conversation's location) and watch per conversation. */
export const WorkspaceBackend = local("p2.workspace-backend", {
	version: 1,
	params: { conversation: param.int({ min: 1 }) },
	members: {
		changes: num(),
		query: method(QuerySchema, Result),
		read: method(Read, unsafe<WorkspaceBytes>(unknown())),
		write: method(WriteSchema),
	},
});

/** Holding this object leases the filesystem watch; read-only guests cannot get it. */
export const Workspace = remote("p2.workspace", {
	version: 1,
	params: Input,
	hostAddress: sessionHost,
	variants: { reader: { state: { changes: num() }, methods: { query: method(QuerySchema, Result) } } },
});

/** HTTP transport only, reachable from the server host, never browsers. */
export const WorkspaceTransfer = remote("p2.workspace-transfer", {
	version: 1,
	params: Input,
	hostAddress: sessionHost,
	variants: {
		server: {
			state: {},
			methods: {
				read: method(Read, unsafe<WorkspaceBytes>(unknown())),
				write: method(WriteSchema),
			},
		},
	},
});

/**
 * A request path relative to the workspace root, as POSIX segments: `""` is the root.
 * Rejects absolute paths, `.`/`..`/empty segments, NUL, backslashes, `~` prefixes and
 * anything inside `.git` (repository config can hold credentials). Lexical only;
 * the worker additionally confines canonical paths.
 */
export function workspacePath(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 4096) return undefined;
	if (value === "") return "";
	if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || value.startsWith("~")) return undefined;
	const segments = value.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
	if (segments[0] === ".git") return undefined;
	return value;
}
