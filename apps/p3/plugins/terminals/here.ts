// The open terminals (`TerminalsHere`, server only): the programs running in pseudo-terminals on machines
// (`MachineHost.openPty`, the environments plugin's), each in the workspace it was opened in; the list of them, their
// output as events and the last `BACKLOG` bytes of each. Trusted: it checks no caller; the Terminals kind's objects
// check theirs before they call it. One object per server, held by the plugin while it is loaded (`keepHere`), so a
// terminal outlives its viewers; when the object ends (a reload of the plugin, the server's stop) every program ends
// with it.

import {
	arr,
	contribute,
	event,
	type FacetHost,
	forbidden,
	int,
	invalid,
	local,
	method,
	obj,
	type P3Principal,
	type Static,
	str,
} from "@earendil-works/p3/v1";
import { MachineHosts, type Pty } from "../environments/contract.server.ts";
import { BACKLOG, MAX_TERMINALS, Output, TerminalInfo } from "./contract.ts";
import { messages } from "./messages.ts";

/** An open terminal and the workspace it was opened in. */
export const OpenTerminal = obj({ workspace: str(), terminal: TerminalInfo });

/** An open terminal and its workspace (see `OpenTerminal`). */
export type OpenTerminal = Static<typeof OpenTerminal>;

/** The terminals: their list, their output, and what is done to them. */
export const TerminalsHere = local("terminals.here", {
	version: 1,
	params: {},
	members: {
		terminals: arr(OpenTerminal),
		output: event(Output),
		backlog: method(obj({ terminal: str() }), obj({ seq: int(), data: str() })),
		open: method(
			obj({ workspace: str(), machine: str(), folder: str(), columns: int(), rows: int(), openedBy: str() }),
			str(),
		),
		input: method(obj({ terminal: str(), data: str() })),
		resize: method(obj({ terminal: str(), columns: int(), rows: int() })),
		close: method(obj({ terminal: str() })),
	},
});

/** A terminal's output kept for viewers who come later: pieces, oldest first, their bytes, and the last piece's number. */
type Kept = { readonly pieces: Uint8Array[]; bytes: number; seq: number };

/** A running terminal: its program and its kept output. */
type Running = { readonly pty: Pty; readonly kept: Kept };

/** Serves `TerminalsHere` on `host`, and holds it while the plugin is loaded. */
export function serveHere(host: FacetHost<P3Principal>): void {
	contribute(host, "terminals.keep", (self) => void self.get(TerminalsHere, {}));
	host.serve(TerminalsHere, (_params, self) => {
		const hosts = self.registry(MachineHosts);
		const list = self.writable<OpenTerminal[]>([]);
		const output = self.events<Output>();
		const running = new Map<string, Running>();
		// Every program ends with the object: nobody could reach it after.
		self.open(
			async () => running,
			(all) => {
				for (const { pty } of all.values()) pty.close();
				all.clear();
			},
		);
		const runningOf = (terminal: string): Running => {
			const found = running.get(terminal);
			if (found === undefined) {
				throw invalid("args", `terminals: no terminal ${terminal}`, { message: messages.message("noTerminal") });
			}
			return found;
		};
		/** Replaces terminal `id`'s entry in the list with `change(entry)`. */
		const update = (id: string, change: (info: TerminalInfo) => TerminalInfo) =>
			list.set(
				list.value.map((open) => (open.terminal.id === id ? { ...open, terminal: change(open.terminal) } : open)),
			);
		return {
			terminals: self.derive([list], ([all]) => all),
			output,
			backlog: async ({ terminal }) => {
				const { kept } = runningOf(terminal);
				return { seq: kept.seq, data: Buffer.concat(kept.pieces).toString("base64") };
			},
			open: async ({ workspace, machine, folder, columns, rows, openedBy }, ctx) => {
				if (list.value.filter((open) => open.workspace === workspace).length >= MAX_TERMINALS) {
					throw forbidden(`terminals: ${MAX_TERMINALS} terminals open in ${workspace}`, {
						message: messages.message("tooMany"),
					});
				}
				const at = hosts.value(machine);
				if (at === undefined) throw invalid("args", `terminals: no machine ${machine}`);
				const id = crypto.randomUUID();
				// Output can come before `openPty` resolves: it is kept from the first piece on.
				const kept: Kept = { pieces: [], bytes: 0, seq: 0 };
				const onData = (bytes: Uint8Array) => {
					keep(kept, bytes);
					output.emit({ terminal: id, seq: kept.seq, data: Buffer.from(bytes).toString("base64") });
				};
				const pty = await at.openPty({ cwd: folder, columns, rows, onData }, ctx);
				const entry: Running = { pty, kept };
				running.set(id, entry);
				const terminal = { id, machine, folder, columns, rows, openedBy, exitCode: null };
				list.set([...list.value, { workspace, terminal }]);
				void pty.exited.then((exitCode) => {
					if (running.get(id) === entry) update(id, (info) => ({ ...info, exitCode }));
				});
				return id;
			},
			input: async ({ terminal, data }) => {
				runningOf(terminal).pty.write(data);
				return null;
			},
			resize: async ({ terminal, columns, rows }) => {
				runningOf(terminal).pty.resize(columns, rows);
				update(terminal, (info) => ({ ...info, columns, rows }));
				return null;
			},
			close: async ({ terminal }) => {
				runningOf(terminal).pty.close();
				running.delete(terminal);
				list.set(list.value.filter((open) => open.terminal.id !== terminal));
				return null;
			},
		};
	});
}

/** Keeps `bytes` as the next piece of `kept`, dropping the oldest pieces beyond `BACKLOG` bytes. */
function keep(kept: Kept, bytes: Uint8Array): void {
	kept.seq += 1;
	kept.pieces.push(bytes);
	kept.bytes += bytes.length;
	while (kept.bytes > BACKLOG && kept.pieces.length > 1) kept.bytes -= kept.pieces.shift()!.length;
}
