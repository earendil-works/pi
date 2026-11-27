// The terminals' harness part, called as the harness calls it (a stand-in reference with its grants and members):
// no tool without Use on the nearest Terminals; with it, one tool `terminal` whose tagged action lists the terminals
// (JSON), opens one at the conversation's location, types a line (Enter after it) or keys, reads the output as plain
// text and closes; Use withheld after the part was built refuses the next call (forbidden), a conversation on no
// machine refuses to open (invalid).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, isChordError } from "@earendil-works/p3/v1";
import type { HarnessLocation, HarnessSession, HeldThing } from "../../things/contract.worker.ts";
import type { Terminals } from "../kind.ts";
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
	return { thing: "terms", workspace: "w", depth: 0, ref: ref as unknown as HeldThing<typeof Terminals>["ref"] };
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
		assert.deepEqual(toolsOf([held(["terminals", "attach"], {})]), []);
		assert.deepEqual(toolsOf([held(USE, {}), held(["terminals"], {})]), [], "the nearest (last) decides");
	});

	it("gives one tool whose tagged action lists, opens at the location, types, reads plain text and closes", async () => {
		const calls: Calls = {};
		const tools = toolsOf([held(USE, calls, "\u001b[1m$ \u001b[0mls\r\nREADME.md\r\n")]);
		assert.deepEqual(
			tools.map((tool) => tool.name),
			["terminal"],
		);
		assert.deepEqual(JSON.parse(await run(tools, "terminal", { action: { kind: "list" } })), [
			{ id: "t1", folder: "/work", exitCode: null },
			{ id: "t2", folder: "/", exitCode: 1 },
		]);
		assert.deepEqual(JSON.parse(await run(tools, "terminal", { action: { kind: "open" } })), {
			terminal: "t1",
			folder: "/work",
		});
		assert.deepEqual(calls.open, [{ machine: "m1", folder: "/work", columns: 120, rows: 40 }]);
		await run(tools, "terminal", { action: { kind: "type", terminal: "t1", input: "ls" } });
		await run(tools, "terminal", { action: { kind: "keys", terminal: "t1", input: "q" } });
		assert.deepEqual(calls.type, [
			{ terminal: "t1", bytes: "ls\r" },
			{ terminal: "t1", bytes: "q" },
		]);
		assert.equal(await run(tools, "terminal", { action: { kind: "read", terminal: "t1" } }), "$ ls\nREADME.md\n");
		// The kept output's tail only, not the whole backlog (opus round 2, S1).
		assert.deepEqual(calls.backlog, [{ terminal: "t1", max: 64_000 }]);
		assert.equal(await run(tools, "terminal", { action: { kind: "close", terminal: "t1" } }), "{}");
		assert.deepEqual(calls.close, [{ terminal: "t1" }]);
	});

	it("refuses to open where the conversation works on no machine, and once Use is withheld", async () => {
		const thing = held(USE, {});
		const nowhere = toolsOf([thing], session(undefined));
		await assert.rejects(run(nowhere, "terminal", { action: { kind: "open" } }), (error: unknown) =>
			isChordError(error, "invalid"),
		);
		const tools = toolsOf([thing]);
		// The holding's reference loses its members in the flush in which Use is withheld.
		(thing.ref as unknown as Record<string, unknown>).type = undefined;
		await assert.rejects(
			run(tools, "terminal", { action: { kind: "type", terminal: "t1", input: "x" } }),
			(error: unknown) => isChordError(error, "forbidden"),
		);
	});
});
