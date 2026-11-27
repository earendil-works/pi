// The terminals plugin on the server: Terminals' members for one caller (`serveThing`: the things plugin admits every
// caller and registers the kind) over the machines' terminal host (the environments plugin's `TerminalHosts`, which
// runs the programs for its whole lifetime, so a reload of this plugin loses none), the attach socket (socket.ts), and
// the page's permission to compile the terminal emulator's WebAssembly (its CSP's `'wasm-unsafe-eval'`).
// A terminal belongs to its Terminals thing and workspace (the host's owner key); each caller sees the ones of its
// workspace on machines it may use there, checked for the caller (`checkMachine`, through the things plugin's index).
// Anyone with Use types in any terminal here: limiting an agent to the terminals it opened is a limit, postponed
// (decision 89). A Terminals thing that goes takes its terminals with it (its delete hook), and a workspace that goes
// takes the terminals opened there (`workspaceGone`, ERNDL-1143).

import { type Context, contribute, defineFacet, forbidden, invalid, withCancel } from "@earendil-works/p3/v1";
import { Http } from "@earendil-works/p3/v1/server";
import { checkMachine, machineAvailable } from "../environments/contract.server.ts";
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
import { QUIET, SOCKET_PATH, TerminalsKind } from "./kind.ts";
import { messages } from "./messages.ts";
import { serveSocket } from "./socket.ts";

/** How many terminals one workspace has open at most. */
const MAX_TERMINALS = 20;

export default defineFacet((host) => {
	serveThing(host, TerminalsKind, {
		implement: ({ workspace, thing }, { caller }, self) => {
			const terminals = self.registry(TerminalHosts);
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
					self.derive([list, answers], ([rows, given]) =>
						rows.filter((row) => machineAvailable(caller, given[row.machine])),
					),
				attach: async ({ terminal }) => ({
					url: `${SOCKET_PATH}?${new URLSearchParams({ workspace, thing, terminal: usable(terminal) })}`,
				}),
				backlog: async ({ terminal, max, wait }, ctx) => {
					const id = usable(terminal);
					const host = at();
					// The caller's hold on the terminal is checked at each piece of output while it waits (no later than
					// `QUIET` apart), so a loss ends the wait, and again before it is read (Astra, round 1, M4).
					if (wait !== undefined && wait > 0) await quieted(host, id, wait, () => usable(id), ctx);
					usable(id);
					const ended = host.list(owner).find((row) => row.id === id)?.exitCode !== null;
					return { text: TEXT.decode(host.tail(id, max ?? TERMINAL_BACKLOG).bytes), ended };
				},
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
	serveSocket(host);
	// The page draws terminals with libghostty-vt, WebAssembly the page compiles: its CSP must allow that (and only
	// that: no `eval` of scripts).
	contribute(host, "terminals.wasm", (self) =>
		self.contribute(Http, { csp: { "script-src": ["'wasm-unsafe-eval'"] } }),
	);
});

/** A terminal's output as text: UTF-8, a character cut at the start of the tail shown as U+FFFD. */
const TEXT = new TextDecoder();

/**
 * Waits until terminal `id`'s output paused for `QUIET` (no output after the call started counts too), its program
 * ended or it closed, or `wait` milliseconds passed; rejects when `ctx` aborts, or when `check` throws (called before
 * each wait for a piece).
 */
async function quieted(host: TerminalHost, id: string, wait: number, check: () => void, ctx: Context): Promise<void> {
	const deadline = Date.now() + wait;
	let from = host.tail(id, 0).end;
	for (let left = wait; left > 0; left = deadline - Date.now()) {
		check();
		const { context, cancel } = withCancel(ctx);
		const timer = setTimeout(cancel, Math.min(QUIET, left));
		try {
			const next = await host.next(id, from, context);
			if (next.bytes.length === 0) return;
			from = next.from + next.bytes.length;
		} catch (error) {
			if (ctx.abortSignal?.aborted) throw error;
			// The timer's: quiet for `QUIET`, or the deadline.
			return;
		} finally {
			clearTimeout(timer);
		}
	}
}
