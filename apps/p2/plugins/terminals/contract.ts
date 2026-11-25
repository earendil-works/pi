import { arr, bool, int, nul, obj, opt, str, union } from "@earendil-works/pi-schema";
import {
	defineRegistry,
	LocationSchema,
	literal,
	local,
	method,
	param,
	propertiesOf,
	remote,
	serverHost,
} from "@p2/app/v1";
import type { TerminalService } from "./service.ts";

const Empty = obj({});
const Size = obj({
	cols: int({ minimum: 1, maximum: 1000 }),
	rows: int({ minimum: 1, maximum: 1000 }),
});
const Color = int({ minimum: 0, maximum: 0xffffff });
/** The server's terminal service (host-internal): open while held; its service is the `TerminalServices` native. */
export const TerminalServiceObject = local("p2.terminal-service", { version: 2, params: {}, members: {} });

/** The open `TerminalServiceObject`'s service: read `.service` at each use. */
export const TerminalServices = defineRegistry<
	{ readonly service: TerminalService },
	{ readonly service: TerminalService } | undefined
>("p2.terminal-services", { version: 1 });

/** One owner-only view, scoped to a session. Control is chord2; terminal input/output is a separate byte channel. */
export const Terminals = remote("p2.terminals", {
	// 2: `open` names the conversation whose location the terminal opens at.
	version: 2,
	params: { session: param.str(), view: param.str() },
	hostAddress: serverHost,
	variants: {
		owner: {
			state: {},
			methods: {
				channel: method(Empty, obj({ token: str() })),
				list: method(Empty),
				/** A new terminal where the session's `conversation` works (a subagent's own location, else the session's). */
				open: method(obj({ ...propertiesOf(Size), conversation: int({ minimum: 1 }) })),
				attach: method(obj({ terminalId: str({ minLength: 1, maxLength: 64 }) })),
				close: method(obj({ force: opt(bool()) })),
				resize: method(Size),
				theme: method(
					obj({
						foreground: Color,
						background: Color,
						scheme: union([literal("light"), literal("dark")]),
					}),
				),
				ack: method(obj({ bytes: int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) })),
				restartHost: method(Empty),
			},
		},
	},
});

const Target = str({ minLength: 1, maxLength: 100 });
/** A key making a call that changes something idempotent: the host does a call with a key it has seen only once. */
const CallKey = str({ minLength: 1, maxLength: 200 });
export const TerminalInfoSchema = obj({
	id: str(),
	sessionId: str(),
	index: int(),
	name: opt(str()),
	agent: opt(bool()),
	cwd: str(),
	env: union([str(), nul()]),
	title: str(),
	createdAt: int(),
	cols: int(),
	rows: int(),
	exited: opt(obj({ code: opt(int()), error: opt(str()) })),
});
export const TerminalWaitSchema = obj({
	until: union([literal("quiet"), literal("exit"), literal("match")]),
	pattern: opt(str({ maxLength: 1000 })),
	ignoreCase: opt(bool()),
	quietMs: opt(int({ minimum: 50, maximum: 60_000 })),
	timeoutMs: int({ minimum: 0, maximum: 120_000 }),
});
export const TerminalReadSchema = obj({
	terminal: TerminalInfoSchema,
	from: int({ minimum: 0 }),
	to: int({ minimum: 0 }),
	text: str(),
	skipped: int({ minimum: 0 }),
	truncated: int({ minimum: 0 }),
	screen: opt(str()),
	waited: opt(union([literal("quiet"), literal("exit"), literal("match"), literal("timeout"), literal("closed")])),
	foreground: opt(str()),
});

/**
 * The terminal tool's calls from a session worker (the agent): its session's terminals, the same the owner sees in
 * the terminal panel. The session comes from the worker's identity; only its current generation is served, never an
 * archived session, and new terminals only on environments the session works on.
 */
export const AgentTerminals = remote("p2.agent-terminals", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		worker: {
			methods: {
				/** The session's terminals, each with the job in front of its shell while one runs. */
				list: method(Empty, obj({ windows: arr(obj({ terminal: TerminalInfoSchema, foreground: opt(str()) })) })),
				/** A new terminal at `location`, a shell; `command` is typed into it. */
				open: method(
					obj({
						key: CallKey,
						location: LocationSchema,
						name: opt(str({ minLength: 1, maxLength: 60 })),
						command: opt(str({ maxLength: 64 * 1024 })),
					}),
					TerminalInfoSchema,
				),
				/** tmux `send-keys`: key names as keys, other arguments as text; all text when `literal`. */
				send: method(
					obj({ key: CallKey, target: Target, keys: arr(str({ maxLength: 64 * 1024 })), literal: bool() }),
					TerminalInfoSchema,
				),
				/** Where the next read without `from` starts. */
				cursor: method(obj({ target: Target }), obj({ terminal: TerminalInfoSchema, offset: int({ minimum: 0 }) })),
				/** Output since `from` (default: the read cursor) as plain text, after an optional wait. */
				read: method(
					obj({ target: Target, from: opt(int({ minimum: 0 })), wait: opt(TerminalWaitSchema) }),
					TerminalReadSchema,
				),
				/** tmux `capture-pane`: the screen as plain text, up to `scrollback` lines before it; styled with `escapes`. */
				capture: method(
					obj({ target: Target, scrollback: int({ minimum: 0, maximum: 100_000 }), escapes: opt(bool()) }),
					obj({ terminal: TerminalInfoSchema, text: str() }),
				),
				close: method(obj({ key: CallKey, target: Target }), obj({ terminalId: str() })),
			},
		},
	},
});
