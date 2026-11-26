// The terminals plugin on a session's worker: the harness part of `terminals.pane` (card 7b), the agent's terminal
// tools while it has Use on the nearest Terminals: `terminal_open` (a terminal at the conversation's location),
// `terminal_send` (types text, Enter after it unless told not to), `terminal_read` (the output so far as plain text,
// after an optional wait) and `terminal_close`. Every call goes through the agent's held reference, so Use withheld
// meanwhile refuses it. People watch the same terminals in the terminal pane.

import { bool, defineFacet, int, obj, opt, sleep, str } from "@earendil-works/p3/v1";
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

/** How much of a terminal's output `terminal_read` answers at most (its end). */
const READ = 16_000;

/** How long `terminal_read` waits at most before it reads. */
const MAX_WAIT = 30_000;

/** The terminals' harness part (exported for its test): the tools while the nearest Terminals gives Use. */
export const terminalsPart = thingHarnessPart(TerminalsKind, (things, session) => {
	// Never called with none; the nearest is last (stacking "nearest").
	const nearest = things[things.length - 1];
	if (nearest === undefined || !nearest.ref.granted.has("open")) return {};
	return {
		extension: defineExtension({
			name: "terminals",
			tools: [openTool(nearest, session), sendTool(nearest), readTool(nearest), closeTool(nearest)],
		}),
	};
});

/** The tool `terminal_open`: a terminal at the conversation's location; answers its id. */
function openTool(held: Held, session: HarnessSession) {
	return defineTool({
		name: "terminal_open",
		description:
			"Opens a terminal running the shell in your current folder and answers its id. People in the session see it " +
			"and may type in it too. Use it for programs that keep running (servers, watchers, interactive tools); run " +
			"one-off commands with bash.",
		parameters: obj({}),
		execute: async (_args, api, context) => {
			const location = await session.location(api.conversationId, context);
			if (location === undefined) throw new Error("terminals: this conversation works on no machine");
			const id = await member(held, "open")(
				{ machine: location.machine, folder: location.folder, ...SIZE },
				context,
			);
			return { output: [{ type: "text", text: `opened terminal ${id} in ${location.folder}` }] };
		},
	});
}

/** The tool `terminal_send`: types text into a terminal, Enter after it unless `enter` is false. */
function sendTool(held: Held) {
	return defineTool({
		name: "terminal_send",
		description:
			"Types `text` into terminal `terminal` (an id from terminal_open), then Enter unless `enter` is false. " +
			"Control keys as characters: \\u0003 is Ctrl-C.",
		parameters: obj({ terminal: str(), text: str({ max: 64 * 1024 }), enter: opt(bool()) }),
		execute: async ({ terminal, text, enter }, _api, context) => {
			await member(held, "input")({ terminal, data: enter === false ? text : `${text}\r` }, context);
			return { output: [{ type: "text", text: "sent" }] };
		},
	});
}

/** The tool `terminal_read`: a terminal's output so far as plain text (its end), after waiting `wait_ms`. */
function readTool(held: Held) {
	return defineTool({
		name: "terminal_read",
		description:
			`The output of terminal \`terminal\` so far as plain text (the last ${READ} characters), after waiting ` +
			`\`wait_ms\` milliseconds (at most ${MAX_WAIT}) for a program to answer.`,
		parameters: obj({ terminal: str(), wait_ms: opt(int({ min: 0, max: MAX_WAIT })) }),
		replay: "safe",
		execute: async ({ terminal, wait_ms }, _api, context) => {
			if (wait_ms !== undefined && wait_ms > 0) await sleep(wait_ms, context);
			const { data } = await member(held, "backlog")({ terminal }, context);
			const text = plain(Buffer.from(data, "base64").toString()).slice(-READ);
			return { output: [{ type: "text", text: text === "" ? "(no output yet)" : text }] };
		},
	});
}

/** The tool `terminal_close`: ends a terminal's program and removes the terminal. */
function closeTool(held: Held) {
	return defineTool({
		name: "terminal_close",
		description: "Ends the program in terminal `terminal` and closes the terminal for everyone.",
		parameters: obj({ terminal: str() }),
		execute: async ({ terminal }, _api, context) => {
			await member(held, "close")({ terminal }, context);
			return { output: [{ type: "text", text: `closed terminal ${terminal}` }] };
		},
	});
}

/** The held reference's member `name`, there while Use is granted; withheld since, the tool's error says so. */
function member<N extends "open" | "input" | "backlog" | "close">(held: Held, name: N) {
	const found = held.ref[name];
	if (found === undefined) throw new Error("terminals: you may no longer use terminals here");
	return found as NonNullable<Held["ref"][N]>;
}
