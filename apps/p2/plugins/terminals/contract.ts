import { bool, int, obj, opt, str, union } from "@earendil-works/pi-schema";
import { defineRegistry, literal, local, method, param, propertiesOf, remote, serverHost } from "@p2/app/v1";
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
