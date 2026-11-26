// The terminals plugin's contract: Terminals (`terminals.pane`), the one thing in Pi through which people and agents
// open terminals on the machines a workspace sees and watch them (decision 24). One terminal, many viewers: each
// viewer's reference gets its output as events, and its bytes so far with `backlog`. A terminal belongs to the
// workspace it was opened in and is listed there only. Read (Watch) lists terminals, follows their output and reads
// their backlog; Write (Use) opens terminals, reads their backlog, types in them, resizes and closes them. Output is
// raw bytes, base64: a multi-byte character may span two pieces.

import { arr, int, method, nul, obj, type Static, str, union } from "@earendil-works/p3/v1";
import { defineThing } from "../things/kind.ts";
import { messages } from "./messages.ts";

/** A machine thing's id. */
const MachineId = str({ min: 1, max: 200 });

/** A terminal's id. */
const TerminalId = str({ min: 1, max: 100 });

/** A terminal's size in character cells. */
const Columns = int({ min: 1, max: 1000 });

/** A terminal's height in rows. */
const Rows = int({ min: 1, max: 1000 });

/** How many bytes of a terminal's output are kept for viewers who come later. */
export const BACKLOG = 256 * 1024;

/** How many terminals one workspace has open at most. */
export const MAX_TERMINALS = 20;

/**
 * An open terminal: its id, the machine and folder it started in, its size, who opened it (`person:<id>`,
 * `agent:<session>`, `server`), and its exit code once its program ended (`null` while it runs; it stays listed until
 * closed).
 */
export const TerminalInfo = obj({
	id: str(),
	machine: str(),
	folder: str(),
	columns: int(),
	rows: int(),
	openedBy: str(),
	exitCode: union([int(), nul()]),
});

/** An open terminal (see `TerminalInfo`). */
export type TerminalInfo = Static<typeof TerminalInfo>;

/** A piece of a terminal's output: its terminal, its number (counting from 1 per terminal) and its bytes, base64. */
export const Output = obj({ terminal: str(), seq: int({ min: 1 }), data: str() });

/** A piece of a terminal's output (see `Output`). */
export type Output = Static<typeof Output>;

/**
 * Terminals (`terminals.pane`): one per Pi, made by this plugin, linked in Pi only (below it can only be hidden or have
 * its ticks withheld); the nearest one reaching a workspace applies. A new link gives everyone here Watch and Use, the
 * agents Use.
 */
export const TerminalsKind = defineThing("terminals.pane", {
	version: 1,
	makers: "plugin",
	workspaces: "one",
	stacking: "nearest",
	state: {
		/** The terminals open in this workspace, oldest first. */
		terminals: arr(TerminalInfo),
	},
	events: {
		/** Every terminal's output here, piece by piece, as it comes. */
		output: Output,
	},
	methods: {
		/**
		 * A terminal's output so far (the last `BACKLOG` bytes, base64) and the number of its last piece in it: a viewer
		 * shows it, then the `output` events numbered after it.
		 */
		backlog: method(obj({ terminal: TerminalId }), obj({ seq: int({ min: 0 }), data: str() })),
		/** Opens a terminal running the machine's shell in `folder` (absolute); answers its id. */
		open: method(
			obj({ machine: MachineId, folder: str({ min: 1, max: 4096 }), columns: Columns, rows: Rows }),
			str(),
		),
		/** Types `data` into a terminal (keys as the terminal reads them: `\r` is Enter). */
		input: method(obj({ terminal: TerminalId, data: str({ max: 64 * 1024 }) })),
		/** Gives a terminal a new size. */
		resize: method(obj({ terminal: TerminalId, columns: Columns, rows: Rows })),
		/** Ends a terminal's program, if it still runs, and removes it from the list. */
		close: method(obj({ terminal: TerminalId })),
	},
	ticks: {
		read: { label: messages.message("tickRead"), gives: ["terminals", "output", "backlog"] },
		write: { label: messages.message("tickWrite"), gives: ["backlog", "open", "input", "resize", "close"] },
	},
	defaultGrants: { everyone: ["read", "write"], agents: ["write"] },
});

/** Terminals held in a workspace: `TerminalsKind`'s contract. */
export const Terminals = TerminalsKind.contract;
