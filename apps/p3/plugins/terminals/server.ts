// The terminals plugin on the server: Terminals' members for one caller (`serveThing`: the things plugin admits every
// caller and registers the kind) over the machines' terminal host (the environments plugin's `TerminalHosts`, which
// runs the programs for its whole lifetime, so a reload of this plugin loses none), and the attach route (attach.ts).
// A terminal belongs to its Terminals thing and workspace (the host's owner key); each caller sees the ones of its
// workspace on machines it may use there, checked for the caller (`checkMachine`, through the things plugin's index).
// Anyone with Use types in any terminal here: limiting an agent to the terminals it opened is a limit, postponed
// (decision 89). A Terminals thing that goes takes its terminals with it (its delete hook), and a workspace that goes
// takes the terminals opened there (`workspaceGone`, ERNDL-1143).

import { contribute, defineFacet, defineRegistry, forbidden, invalid } from "@earendil-works/p3/v1";
import { checkMachine, MachineTypes, machineAvailable } from "../environments/contract.server.ts";
import {
	TERMINAL_BACKLOG,
	type TerminalHost,
	TerminalHosts,
	TerminalKeeper,
	TerminalList,
	type TerminalOwner,
} from "../environments/contract.terminal-host.server.ts";
import { givesTo } from "../things/contract.server.ts";
import { serveThing } from "../things/serve.ts";
import { serveAttach } from "./attach.ts";
import { ATTACH_PATH, TerminalsKind } from "./kind.ts";
import { messages } from "./messages.ts";

/** How many terminals one workspace has open at most. */
const MAX_TERMINALS = 20;

/**
 * Whether a machine type installed opens terminals (`terminals.opens` of every holder's Terminals): the same for every
 * holder, so it is computed once, here, and read by the list each holder's object derives already.
 */
const Opens = defineRegistry<boolean, boolean>("terminals.opens", { version: 1 });

export default defineFacet((host) => {
	serveThing(host, TerminalsKind, {
		implement: ({ workspace, thing }, { caller }, self) => {
			const terminals = self.registry(TerminalHosts);
			const opens = self.registry(Opens);
			const answers = givesTo(self, workspace, caller);
			const owner: TerminalOwner = { thing, workspace };
			const list = self.get(TerminalList, owner).terminals;
			const at = (): TerminalHost => {
				const found = terminals.value;
				if (found === undefined)
					throw forbidden("terminals: no terminal host", { message: messages.message("noHost") });
				return found;
			};
			/** Terminal `id` as one of this workspace's; refused otherwise. */
			const here = (id: string) => {
				const row = list.value.find((each) => each.id === id);
				if (row === undefined) {
					throw invalid("args", `terminals: no terminal ${id}`, { message: messages.message("noTerminal") });
				}
				return row;
			};
			/** Terminal `id` as the caller may use it: here, on a machine available to the caller. */
			const usable = (id: string) => {
				const { machine } = here(id);
				checkMachine(machine, caller, answers.value[machine]);
				return id;
			};
			return {
				terminals: () =>
					self.derive([list, answers, opens], ([rows, given, opening]) => ({
						rows: rows.filter((row) => machineAvailable(caller, given[row.machine])),
						opens: opening,
					})),
				attach: async ({ terminal }) => ({
					url: `${ATTACH_PATH}?${new URLSearchParams({ workspace, thing, terminal: usable(terminal) })}`,
				}),
				backlog: async ({ terminal, max }) => ({
					data: Buffer.from(at().tail(usable(terminal), max ?? TERMINAL_BACKLOG).bytes).toString("base64"),
				}),
				open: async ({ machine, folder, columns, rows }, ctx) => {
					checkMachine(machine, caller, answers.value[machine]);
					if (!folder.startsWith("/")) {
						throw invalid("args", `terminals: ${folder} is not absolute`, {
							message: messages.message("notAbsolute"),
						});
					}
					return at().open({ owner, machine, folder, columns, rows, max: MAX_TERMINALS }, ctx);
				},
				type: async ({ terminal, bytes }) => {
					if (!at().write(usable(terminal), bytes)) {
						throw invalid("args", `terminals: ${terminal} has ended`, {
							message: messages.message("notRunning"),
						});
					}
					return null;
				},
				resize: async ({ terminal, columns, rows }) => {
					at().resize(usable(terminal), columns, rows);
					return null;
				},
				// Closing only ends a program: anyone with Use here may, the machine available to them or not (so a
				// terminal on a machine hidden since stays closable).
				close: async ({ terminal }) => {
					at().close(here(terminal).id);
					return null;
				},
			};
		},
		delete: async (thing, ctx) => {
			await (await ctx.get(TerminalKeeper, {})).closeThing({ thing }, ctx);
		},
		// Closing what is already closed changes nothing: safe to repeat after a crash.
		workspaceGone: async (workspace, ctx) => {
			await (await ctx.get(TerminalKeeper, {})).closeWorkspace({ workspace }, ctx);
		},
		one: { name: "Terminals" },
	});
	host.serve(Opens, { compose: (table) => table.some((item) => item.value) });
	contribute(host, "terminals.opens", (self) => {
		const types = self.registry(MachineTypes);
		self.contribute(
			Opens,
			self.derive([types], ([installed]) => [...installed.values()].some((type) => type.value.terminals)),
		);
	});
	serveAttach(host);
});
