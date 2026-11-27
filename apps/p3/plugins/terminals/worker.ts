// The terminals plugin on a session's worker: the harness part of `terminals.pane` (card 7b), one tool, `terminal`,
// while the agent has Use on the nearest Terminals: one definition with a tagged `action`, each kind of action with
// the arguments it needs (decision 120: a kind with many actions has one tool; every tool costs every request). Its
// actions: list the terminals here, open one at the conversation's location, type a line (Enter after it) or keys (as
// given), read the output so far as plain text (after an optional wait), close one. Answers are JSON, but a read's,
// which is the terminal's text. Every call goes through the agent's held reference, so Use withheld meanwhile refuses
// it. People watch the same terminals in the Terminals view.

import { defineFacet, forbidden, int, invalid, lit, obj, opt, sleep, str, union } from "@earendil-works/p3/v1";
import { defineExtension, defineTool } from "@earendil-works/p3/v1/worker";
import { type HarnessSession, type HeldThing, ThingHarnessParts, thingHarnessPart } from "../things/contract.worker.ts";
import { TerminalId, type Terminals, TerminalsKind } from "./kind.ts";
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
	return { extension: defineExtension({ name: TerminalsKind.name, tools: [terminalTool(nearest, session)] }) };
});

/** What the tool does: one action, with the arguments its kind needs. */
const Action = union([
	obj({ kind: lit("list") }),
	obj({ kind: lit("open") }),
	obj({ kind: lit("type"), terminal: TerminalId, input: str({ max: 64 * 1024 }) }),
	obj({ kind: lit("keys"), terminal: TerminalId, input: str({ max: 64 * 1024 }) }),
	obj({ kind: lit("read"), terminal: TerminalId, wait_ms: opt(int({ min: 0, max: MAX_WAIT })) }),
	obj({ kind: lit("close"), terminal: TerminalId }),
]);

/** The tool `terminal`. */
function terminalTool(held: Held, session: HarnessSession) {
	return defineTool({
		name: "terminal",
		description:
			"Terminals people in the session see and may type in too, for programs that keep running (servers, " +
			"watchers, interactive tools); run one-off commands with bash. `action.kind`: `list` the terminals here " +
			"(JSON: each `id`, `folder`, `exitCode`); `open` one in your current folder (JSON: its `terminal` id); " +
			"`type` the line `input` into `terminal`, Enter after it; `keys` sends `input` as given (\\u0003 is " +
			`Ctrl-C, \\r is Enter); \`read\` the output of \`terminal\` so far as plain text (its last ${READ} ` +
			`characters), after waiting \`wait_ms\` (at most ${MAX_WAIT}); \`close\` ends its program and closes it ` +
			"for everyone. `terminal` is an id `list` or `open` answered.",
		parameters: obj({ action: Action }),
		execute: async ({ action }, api, context) => {
			const ref = usable(held);
			const json = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });
			switch (action.kind) {
				case "list":
					return json(ref.terminals.value.map(({ id, folder, exitCode }) => ({ id, folder, exitCode })));
				case "open": {
					const location = await session.location(api.conversationId, context);
					if (location === undefined) {
						throw invalid("args", "terminal: this conversation works on no machine, so no terminal opens here");
					}
					const terminal = await ref.open(
						{ machine: location.machine, folder: location.folder, ...SIZE },
						context,
					);
					return json({ terminal, folder: location.folder });
				}
				case "type":
				case "keys": {
					const bytes = action.kind === "type" ? `${action.input}\r` : action.input;
					await ref.type({ terminal: action.terminal, bytes }, context);
					return json({});
				}
				case "read": {
					if (action.wait_ms !== undefined && action.wait_ms > 0) await sleep(action.wait_ms, context);
					const { data } = await ref.backlog({ terminal: action.terminal, max: READ_BYTES }, context);
					const output = plain(Buffer.from(data, "base64").toString()).slice(-READ);
					return { output: [{ type: "text" as const, text: output === "" ? "(no output yet)" : output }] };
				}
				case "close":
					await ref.close({ terminal: action.terminal }, context);
					return json({});
			}
		},
	});
}

/** The held reference with Use's members, as it is now; Use withheld since, the tool refuses. */
function usable(held: Held) {
	const { ref } = held;
	const { terminals, open, type, backlog, close } = ref;
	if (!terminals || !open || !type || !backlog || !close) {
		throw forbidden("terminal: you may no longer use terminals here");
	}
	return { terminals, open, type, backlog, close };
}
