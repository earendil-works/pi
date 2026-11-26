// The terminals' harness part, called as the harness calls it (a stand-in reference with its grants and members):
// no tools without Use on the nearest Terminals; with it, `terminal_open` opens at the conversation's location,
// `terminal_send` types (Enter after unless told not to), `terminal_read` answers the output as plain text and
// `terminal_close` closes; Use withheld after the part was built refuses the next call.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import type { HarnessLocation, HarnessSession, HeldThing } from "../../things/contract.worker.ts";
import type { Terminals } from "../contract.ts";
import { terminalsPart } from "../worker.ts";

/** What the stand-in reference was called with, by member. */
type Calls = Record<string, unknown[]>;

/** The session the part is called for: its conversations work at `location`. */
function session(location: HarnessLocation | undefined): HarnessSession {
	return {
		session: "s",
		workspace: "w",
		call: () => Promise.reject(new Error("no call")),
		location: async () => location,
	};
}

/** A held Terminals whose reference has `granted` and records its calls in `calls`; `backlog` answers `output`. */
function held(granted: readonly string[], calls: Calls, output = ""): HeldThing<typeof Terminals> {
	const recorded =
		(name: string, answer: unknown) =>
		async (args: unknown): Promise<unknown> => {
			calls[name] = [...(calls[name] ?? []), args];
			return answer;
		};
	const ref: Record<string, unknown> = { granted: new Set(granted) };
	const answers: Record<string, unknown> = {
		open: "t1",
		input: null,
		close: null,
		backlog: { seq: 1, data: Buffer.from(output).toString("base64") },
	};
	for (const [name, answer] of Object.entries(answers)) if (granted.includes(name)) ref[name] = recorded(name, answer);
	// A stand-in for the holding's reference: the part reads only `granted` and the members.
	return { thing: "terms", workspace: "w", ref: ref as unknown as HeldThing<typeof Terminals>["ref"] };
}

/** What Use grants. */
const USE = ["backlog", "open", "input", "resize", "close"];

/** Runs tool `name` of `tools` with `args`; its output text. */
async function run(tools: ReturnType<typeof toolsOf>, name: string, args: object): Promise<string> {
	const tool = tools.find((entry) => entry.name === name);
	assert.ok(tool, `tool ${name}`);
	// The tools read only `conversationId` of the api.
	const result = await tool.execute(args as never, { conversationId: 7 } as never, context);
	const [first] = result.output ?? [];
	return first?.type === "text" ? first.text : "";
}

/** The tools the part gives for `things` in `at`. */
function toolsOf(things: HeldThing<typeof Terminals>[], at = session({ machine: "m1", folder: "/work" })) {
	return terminalsPart.part(things, at).extension?.tools ?? [];
}

describe("the terminals' harness part", () => {
	it("gives no tools without Use on the nearest Terminals", () => {
		assert.deepEqual(toolsOf([held(["terminals", "output", "backlog"], {})]), []);
		assert.deepEqual(toolsOf([held(USE, {}), held(["backlog"], {})]), [], "the nearest (last) decides");
	});

	it("opens at the location, types, reads plain text and closes", async () => {
		const calls: Calls = {};
		const tools = toolsOf([held(USE, calls, "\u001b[1m$ \u001b[0mls\r\nREADME.md\r\n")]);
		assert.deepEqual(tools.map((tool) => tool.name).sort(), [
			"terminal_close",
			"terminal_open",
			"terminal_read",
			"terminal_send",
		]);
		assert.equal(await run(tools, "terminal_open", {}), "opened terminal t1 in /work");
		assert.deepEqual(calls.open, [{ machine: "m1", folder: "/work", columns: 120, rows: 40 }]);
		await run(tools, "terminal_send", { terminal: "t1", text: "ls" });
		await run(tools, "terminal_send", { terminal: "t1", text: "q", enter: false });
		assert.deepEqual(calls.input, [
			{ terminal: "t1", data: "ls\r" },
			{ terminal: "t1", data: "q" },
		]);
		assert.equal(await run(tools, "terminal_read", { terminal: "t1" }), "$ ls\nREADME.md\n");
		await run(tools, "terminal_close", { terminal: "t1" });
		assert.deepEqual(calls.close, [{ terminal: "t1" }]);
	});

	it("refuses to open where the conversation works on no machine, and once Use is withheld", async () => {
		const thing = held(USE, {});
		const nowhere = toolsOf([thing], session(undefined));
		await assert.rejects(run(nowhere, "terminal_open", {}), /no machine/);
		const tools = toolsOf([thing]);
		// The holding's reference loses its members in the flush in which Use is withheld.
		(thing.ref as unknown as Record<string, unknown>).input = undefined;
		await assert.rejects(run(tools, "terminal_send", { terminal: "t1", text: "x" }), /no longer use/);
	});
});
