// The terminals plugin on a session's worker: the harness part of `terminals.pane` (card 7b), one tool, `terminal`,
// while the agent has Use on the nearest Terminals (one definition: every tool costs every request). Its actions: list
// the terminals here, open one at the conversation's location, type a line (Enter after it) or keys (as given), read
// the output so far as plain text (after an optional wait), close one. Every call goes through the agent's held
// reference, so Use withheld meanwhile refuses it. People watch the same terminals in the terminal pane.

import { defineFacet, int, obj, oneOf, opt, sleep, str } from "@earendil-works/p3/v1";
import { defineExtension, defineTool } from "@earendil-works/p3/v1/worker";
import { type HarnessSession, type HeldThing, ThingHarnessParts, thingHarnessPart } from "../things/contract.worker.ts";
import { type Terminals, TerminalsKind } from "./contract.ts";
import { plain } from "./plain.ts";

export default defineFacet((_host, self) => {
	self.contribute(ThingHarnessParts, terminalsPart);
});

/** Terminals as the agent holds it. */
type Held = HeldThing<typeof Terminals>;

/** The size of a terminal the agent opens. */
const SIZE = { columns: 120, rows: 40 };

/** How much of a terminal's output `read` answers at most (its end). */
const READ = 16_000;

/** How many bytes of kept output `read` asks for: enough for `READ` characters once escapes are taken out. */
const READ_BYTES = 4 * READ;

/** How long `read` waits at most before it reads. */
const MAX_WAIT = 30_000;

/** The terminals' harness part (exported for its test): the tool while the nearest Terminals gives Use. */
export const terminalsPart = thingHarnessPart(TerminalsKind, (things, session) => {
	// Never called with none; the nearest is last (stacking "nearest").
	const nearest = things[things.length - 1];
	if (nearest === undefined || !nearest.ref.granted.has("open")) return {};
	return { extension: defineExtension({ name: "terminals", tools: [terminalTool(nearest, session)] }) };
});

/** The tool `terminal`. */
function terminalTool(held: Held, session: HarnessSession) {
	return defineTool({
		name: "terminal",
		description:
			"Terminals people in the session see and may type in too, for programs that keep running (servers, " +
			"watchers, interactive tools); run one-off commands with bash. Actions: `list` the terminals here; `open` " +
			"one in your current folder (answers its id); `type` the line `input` into `terminal`, Enter after it; " +
			"`keys` sends `input` as given (\\u0003 is Ctrl-C, \\r is Enter); `read` the output of `terminal` so far as " +
			`plain text (its last ${READ} characters), after waiting \`wait_ms\` (at most ${MAX_WAIT}); \`close\` ends ` +
			"its program and closes it for everyone.",
		parameters: obj({
			action: oneOf("list", "open", "type", "keys", "read", "close"),
			terminal: opt(str()),
			input: opt(str({ max: 64 * 1024 })),
			wait_ms: opt(int({ min: 0, max: MAX_WAIT })),
		}),
		execute: async ({ action, terminal, input, wait_ms }, api, context) => {
			const ref = usable(held);
			const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
			switch (action) {
				case "list": {
					const rows = ref.terminals.value;
					if (rows.length === 0) return text("no terminals here");
					return text(rows.map((row) => `${row.id} ${row.folder}${ended(row.exitCode)}`).join("\n"));
				}
				case "open": {
					const location = await session.location(api.conversationId, context);
					if (location === undefined) throw new Error("terminal: this conversation works on no machine");
					const id = await ref.open({ machine: location.machine, folder: location.folder, ...SIZE }, context);
					return text(`opened terminal ${id} in ${location.folder}`);
				}
				case "type":
				case "keys": {
					const bytes = action === "type" ? `${input ?? ""}\r` : (input ?? "");
					await ref.type({ terminal: named(terminal), bytes }, context);
					return text("sent");
				}
				case "read": {
					if (wait_ms !== undefined && wait_ms > 0) await sleep(wait_ms, context);
					const { data } = await ref.backlog({ terminal: named(terminal), max: READ_BYTES }, context);
					const output = plain(Buffer.from(data, "base64").toString()).slice(-READ);
					return text(output === "" ? "(no output yet)" : output);
				}
				case "close": {
					await ref.close({ terminal: named(terminal) }, context);
					return text(`closed terminal ${terminal}`);
				}
			}
		},
	});
}

/** The held reference with Use's members, as it is now; Use withheld since, the tool's error says so. */
function usable(held: Held) {
	const { ref } = held;
	const { terminals, open, type, backlog, close } = ref;
	if (!terminals || !open || !type || !backlog || !close) {
		throw new Error("terminal: you may no longer use terminals here");
	}
	return { terminals, open, type, backlog, close };
}

/** The terminal an action names; refused when it names none. */
function named(terminal: string | undefined): string {
	if (terminal === undefined) throw new Error("terminal: this action needs `terminal`");
	return terminal;
}

/** How a listed terminal shows that its program ended. */
function ended(exitCode: number | null): string {
	return exitCode === null ? "" : ` (ended with code ${exitCode})`;
}
