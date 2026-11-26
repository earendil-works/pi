// The terminals' harness part, called as the harness calls it (a stand-in reference with its grants and members):
// no tool without Use on the nearest Terminals; with it, one tool `terminal` whose actions list the terminals, open
// one at the conversation's location, type a line (Enter after it) or keys, read the output as plain text and close;
// Use withheld after the part was built refuses the next call.

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
		type: null,
		close: null,
		backlog: { data: Buffer.from(output).toString("base64") },
	};
	for (const [name, answer] of Object.entries(answers)) if (granted.includes(name)) ref[name] = recorded(name, answer);
	if (granted.includes("terminals")) {
		ref.terminals = {
			value: [
				{ id: "t1", folder: "/work", exitCode: null },
				{ id: "t2", folder: "/", exitCode: 1 },
			],
		};
	}
	// A stand-in for the holding's reference: the part reads only `granted` and the members.
	return { thing: "terms", workspace: "w", ref: ref as unknown as HeldThing<typeof Terminals>["ref"] };
}

/** What Use grants. */
const USE = ["terminals", "attach", "backlog", "open", "type", "resize", "close"];

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
	it("gives no tool without Use on the nearest Terminals", () => {
		assert.deepEqual(toolsOf([held(["terminals", "attach", "backlog"], {})]), []);
		assert.deepEqual(toolsOf([held(USE, {}), held(["backlog"], {})]), [], "the nearest (last) decides");
	});

	it("gives one tool that lists, opens at the location, types, reads plain text and closes", async () => {
		const calls: Calls = {};
		const tools = toolsOf([held(USE, calls, "\u001b[1m$ \u001b[0mls\r\nREADME.md\r\n")]);
		assert.deepEqual(
			tools.map((tool) => tool.name),
			["terminal"],
		);
		assert.equal(await run(tools, "terminal", { action: "list" }), "t1 /work\nt2 / (ended with code 1)");
		assert.equal(await run(tools, "terminal", { action: "open" }), "opened terminal t1 in /work");
		assert.deepEqual(calls.open, [{ machine: "m1", folder: "/work", columns: 120, rows: 40 }]);
		await run(tools, "terminal", { action: "type", terminal: "t1", input: "ls" });
		await run(tools, "terminal", { action: "keys", terminal: "t1", input: "q" });
		assert.deepEqual(calls.type, [
			{ terminal: "t1", bytes: "ls\r" },
			{ terminal: "t1", bytes: "q" },
		]);
		assert.equal(await run(tools, "terminal", { action: "read", terminal: "t1" }), "$ ls\nREADME.md\n");
		await run(tools, "terminal", { action: "close", terminal: "t1" });
		assert.deepEqual(calls.close, [{ terminal: "t1" }]);
		await assert.rejects(run(tools, "terminal", { action: "close" }), /needs `terminal`/);
	});

	it("refuses to open where the conversation works on no machine, and once Use is withheld", async () => {
		const thing = held(USE, {});
		const nowhere = toolsOf([thing], session(undefined));
		await assert.rejects(run(nowhere, "terminal", { action: "open" }), /no machine/);
		const tools = toolsOf([thing]);
		// The holding's reference loses its members in the flush in which Use is withheld.
		(thing.ref as unknown as Record<string, unknown>).type = undefined;
		await assert.rejects(run(tools, "terminal", { action: "type", terminal: "t1", input: "x" }), /no longer use/);
	});
});
