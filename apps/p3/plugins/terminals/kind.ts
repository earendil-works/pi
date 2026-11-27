// The terminals kind: Terminals (`terminals.pane`), the one thing in Pi through which people and agents
// open terminals on the machines a workspace sees and watch them (decision 24). A terminal runs on its machine's
// terminal host (the environments plugin's), belongs to the Terminals thing and the workspace it was opened in, and is
// listed there only. One terminal, many viewers: each viewer reads its bytes from the address `attach` answers (its
// kept output, then what follows, raw), the agent its kept output with `backlog`. Watch (for people) lists terminals
// and attaches to them; Use (people and agents) does that too, and opens terminals, types in them, reads their kept
// output, resizes and closes them. By default only the agents get Use; people get a tick through Who may.

import { arr, int, method, obj, opt, str } from "@earendil-works/p3/v1";
import { TerminalRow } from "../environments/contract.ts";
import { defineThing } from "../things/kind.ts";
import { messages } from "./messages.ts";

/** A machine thing's id. */
const MachineId = str({ min: 1, max: 200 });

/** A terminal's id, as `open` answers it and the list shows it. */
export const TerminalId = str({ min: 1, max: 100 });

/** A terminal's size in character cells. */
const Columns = int({ min: 1, max: 1000 });

/** A terminal's height in rows. */
const Rows = int({ min: 1, max: 1000 });

/**
 * Terminals (`terminals.pane`): one per Pi, made by this plugin, linked in Pi only (below it can only be hidden or have
 * its ticks withheld); the nearest one reaching a workspace applies. A new link gives everyone here Watch and the
 * agents Use; Use for people is the owner's (the owner flag) and whoever it is granted to.
 */
export const TerminalsKind = defineThing("terminals.pane", {
	version: 1,
	makers: "plugin",
	workspaces: "one",
	stacking: "nearest",
	state: {
		/** The terminals open in this workspace on machines the caller may use here, oldest first. */
		terminals: arr(TerminalRow),
	},
	methods: {
		/**
		 * The address a browser reads a terminal's bytes from: its kept output, then what follows, raw, until it ends or
		 * the person loses Watch and Use (served while the person holds Terminals).
		 */
		attach: method(obj({ terminal: TerminalId }), obj({ url: str() })),
		/**
		 * A terminal's kept output, its last `max` bytes at most (base64), for an agent reading what its program printed.
		 */
		backlog: method(obj({ terminal: TerminalId, max: opt(int({ min: 0 })) }), obj({ data: str() })),
		/** Opens a terminal running the machine's shell in `folder` (absolute); answers its id. */
		open: method(
			obj({ machine: MachineId, folder: str({ min: 1, max: 4096 }), columns: Columns, rows: Rows }),
			str(),
		),
		/** Types `bytes` into a terminal (keys as the terminal reads them: `\r` is Enter); refused once its program ends. */
		type: method(obj({ terminal: TerminalId, bytes: str({ max: 64 * 1024 }) })),
		/** Gives a terminal a new size. */
		resize: method(obj({ terminal: TerminalId, columns: Columns, rows: Rows })),
		/** Ends a terminal's program, if it still runs, and removes it from the list. */
		close: method(obj({ terminal: TerminalId })),
	},
	ticks: {
		// No member is plain: someone let in with no tick gets an empty object. A member may be in both ticks (97).
		watch: { label: messages.message("tickWatch"), for: "people", gives: ["terminals", "attach"] },
		use: {
			label: messages.message("tickUse"),
			gives: ["terminals", "attach", "backlog", "open", "type", "resize", "close"],
		},
	},
	// The agents use them (the terminal tool); people, guests too, only once Who may lets them: a terminal shows what
	// runs on the machine (round 5, decision 100's guests line withdrawn here, until folder limits, ERNDL-1151).
	defaultGrants: { agents: ["use"] },
});

/** Terminals held in a workspace: `TerminalsKind`'s contract. */
export const Terminals = TerminalsKind.contract;

/** The attach route's path; its query names the workspace, the thing and the terminal. */
export const ATTACH_PATH = "/terminals/attach";
