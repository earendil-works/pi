// The terminals plugin on the server: Terminals' members for one caller (`serveThing`: the things plugin admits every
// caller and registers the kind) over the open terminals (`TerminalsHere`, here.ts), each caller seeing the ones of
// its workspace. Each call reaches
// the terminal's machine as the caller (`reachMachine`: available to the caller in this workspace, through the things
// plugin's index); the list and the output show only terminals on machines the caller may use here. Anyone with Use
// types in any terminal here: limiting an agent to the terminals it opened is a limit, postponed (decision 89).

import { type Ctx, defineFacet, invalid, type P3Principal } from "@earendil-works/p3/v1";
import { MachineHosts, machineAvailable, reachMachine } from "../environments/contract.server.ts";
import { Gives } from "../things/contract.server.ts";
import type { Caller } from "../things/contract.ts";
import { serveThing } from "../things/serve.ts";
import { type Output, TerminalsKind } from "./contract.ts";
import { type OpenTerminal, serveHere, TerminalsHere } from "./here.ts";
import { messages } from "./messages.ts";

export default defineFacet((host) => {
	serveHere(host);
	serveThing(host, TerminalsKind, {
		one: { name: "Terminals" },
		implement: ({ workspace }, { caller }, self) => {
			const here = self.get(TerminalsHere, {});
			const hosts = self.registry(MachineHosts);
			// The server (trusted code) is no party anywhere: it reaches every machine without an answer.
			const gives = caller.kind === "server" ? undefined : self.get(Gives, { workspace, caller: keyOf(caller) });
			const by = openerOf(caller);
			const answer = (machine: string) => gives?.answers.value[machine];
			/** Whether the caller sees `open`: opened in this workspace, on a machine it may use here. */
			const sees = ({ workspace: where, terminal }: OpenTerminal) =>
				where === workspace && machineAvailable(caller, answer(terminal.machine));
			const openOf = (id: string) => here.terminals.value.find((open) => open.terminal.id === id);
			/** Terminal `id` as the caller may use it: refused unless it is here, on a machine available to the caller. */
			const usable = (id: string) => {
				const open = openOf(id);
				if (open === undefined || open.workspace !== workspace) {
					throw invalid("args", `terminals: no terminal ${id}`, { message: messages.message("noTerminal") });
				}
				reachMachine(open.terminal.machine, caller, answer(open.terminal.machine), hosts.value);
				return id;
			};
			return {
				terminals: () =>
					self.derive([here.terminals, ...(gives === undefined ? [] : [gives.answers])], ([all]) =>
						all.filter(sees).map((open) => open.terminal),
					),
				// Each watcher gets the pieces of the terminals it sees: one subscription, ended with the object.
				output: () => {
					const output = self.events<Output>();
					self.open(
						(ctx) =>
							here.output.on(({ value }) => {
								const open = openOf(value.terminal);
								if (open !== undefined && sees(open)) output.emit(value);
							}, ctx),
						(subscription) => subscription.stop(),
					);
					return output;
				},
				backlog: ({ terminal }, ctx) => here.backlog({ terminal: usable(terminal) }, ctx),
				open: ({ machine, folder, columns, rows }, ctx: Ctx<P3Principal>) => {
					reachMachine(machine, caller, answer(machine), hosts.value);
					if (!folder.startsWith("/")) {
						throw invalid("args", `terminals: ${folder} is not absolute`, {
							message: messages.message("notAbsolute"),
						});
					}
					return here.open({ workspace, machine, folder, columns, rows, openedBy: by }, ctx);
				},
				input: ({ terminal, data }, ctx) => here.input({ terminal: usable(terminal), data }, ctx),
				resize: ({ terminal, columns, rows }, ctx) =>
					here.resize({ terminal: usable(terminal), columns, rows }, ctx),
				close: ({ terminal }, ctx) => here.close({ terminal: usable(terminal) }, ctx),
			};
		},
	});
});

/** Who opened a terminal, as the list keeps it: `person:<id>`, `agent:<session>`, `server`. */
function openerOf(caller: Caller): string {
	switch (caller.kind) {
		case "person":
			return `person:${caller.person}`;
		case "agent":
			return `agent:${caller.session}`;
		case "server":
			return "server";
	}
}

/** The caller's key as `Gives` takes it (`callerKey` of its principal). */
function keyOf(caller: Exclude<Caller, { kind: "server" }>): string {
	return caller.kind === "person" ? `person:${caller.person}` : `worker:${caller.session}`;
}
