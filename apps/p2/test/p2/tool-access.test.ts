// Tool requirements (`src/runtime/tool-access.ts`) and the tools an agent gives its subagents and one-shot agents
// (`plugins/subagents/contract.worker.ts`): checked before each call, resolved from the caller's own tools.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration, Tx } from "@earendil-works/pi-durable";
import { resolveTools } from "../../plugins/subagents/contract.worker.ts";
import { guardTool, type P2Tool } from "../../src/runtime/tool-access.ts";

const tool = (name: string, fields: Partial<P2Tool> = {}): P2Tool => ({
	name,
	description: name,
	parameters: { type: "object" },
	execute: async () => ({ output: [{ type: "text", text: `${name} ran` }] }),
	...fields,
});
const context = {} as never;

/** A call's API in conversation `conversationId`, whose run placed one input with `data`. */
const api = (conversationId: number, data: unknown): ToolExecutionApi =>
	({
		conversationId,
		snapshot: async (doc: { definition: { kind: string } }) =>
			doc.definition.kind === "pi.live" ? { run: { inputs: [1] } } : undefined,
		commit: async (change: (tx: Tx) => unknown) =>
			change({
				submission: async () => ({ type: "input", entry: 1 }),
				entry: async () => ({ id: 1, kind: "p2.input", data }),
			} as unknown as Tx),
	}) as unknown as ToolExecutionApi;
const owner = { author: { kind: "owner", id: "owner", name: "Owner" }, text: "x", attachments: [] };
const guest = { author: { kind: "guest", id: "g", name: "Guest" }, text: "x", attachments: [] };
const text = (result: ToolExecutionResult) => {
	const [first] = result.output ?? [];
	return first?.type === "text" ? first.text : undefined;
};

describe("tool requirements", () => {
	it("runs tools without requirements unchanged", () => {
		const plain = tool("read");
		assert.equal(guardTool(plain), plain);
		const subagentOnly = tool("team", { scope: "subagent" });
		assert.equal(guardTool(subagentOnly), subagentOnly);
	});

	it("refuses an owner-only tool in a turn the owner did not start, and a main-only tool outside the main conversation", async () => {
		const owned = guardTool(tool("ports", { origin: "owner", scope: "main" }));
		assert.equal(text(await owned.execute({}, api(1, owner), context)), "ports ran");
		assert.match(text(await owned.execute({}, api(1, guest), context)) ?? "", /needs a turn the owner started/);
		// Conversation 2 is no top-level conversation (no `/tree` branches): a subagent's.
		assert.match(text(await owned.execute({}, api(2, owner), context)) ?? "", /works only in the session's main/);
		const anywhere = guardTool(tool("location_envs", { origin: "owner" }));
		assert.equal(text(await anywhere.execute({}, api(2, owner), context)), "location_envs ran");
	});
});

describe("tools given to agents", () => {
	const registered = [
		tool("read"),
		tool("bash"),
		tool("codemode", { callers: ["model"] }),
		tool("agent", { callers: ["tools"] }),
		tool("mcp__files__echo", { callers: ["tools"], deferred: true, origin: "owner" }),
		tool("powershell", { deferred: true }),
		tool("subagent", { scope: "main" }),
		tool("rename_session", { scope: "main" }),
		tool("team", { deferred: true, scope: "subagent" }),
	];
	const access = new Map(registered.map((each) => [each.name, each]));
	const pick = (...names: string[]) => registered.filter((each) => names.includes(each.name));
	// The main agent: its model is offered these, `powershell` and `team` are deferred, scripts call the rest.
	const caller = {
		tools: pick("read", "bash", "codemode", "subagent", "rename_session"),
		deferred: pick("powershell", "team"),
		callable: pick("read", "bash", "agent", "mcp__files__echo", "subagent", "rename_session", "powershell", "team"),
	};
	const names = (tools: readonly ToolRegistration[]) => tools.map((each) => each.name);

	it("gives a subagent every tool its caller may give by default, with the script-only ones and team", () => {
		const choice = resolveTools(caller, access, undefined, [], "subagent");
		assert(typeof choice !== "string");
		assert.deepEqual(choice.chosen, ["read", "bash", "codemode", "powershell"]);
		assert.deepEqual(names(choice.tools), [
			"read",
			"bash",
			"codemode",
			"powershell",
			"agent",
			"mcp__files__echo",
			"team",
		]);
		// Deferred tools stay deferred; `team` is offered from the start.
		assert.deepEqual(names(choice.loaded), ["team"]);
	});

	it("narrows to the named tools in their order; named deferred ones are offered from the start", () => {
		const choice = resolveTools(caller, access, ["powershell", "read", "read"], ["powershell", "read"], "one-shot");
		assert(typeof choice !== "string");
		assert.deepEqual(choice.chosen, ["powershell", "read"]);
		// No code mode: no script-only tools; a one-shot agent gets no `team`.
		assert.deepEqual(names(choice.tools), ["powershell", "read"]);
		assert.deepEqual(names(choice.loaded), ["powershell"]);
	});

	it("refuses session-level, subagent-only, script-only and unknown tools", () => {
		for (const name of ["subagent", "rename_session", "team", "agent", "bogus"]) {
			const refused = resolveTools(caller, access, ["read", name], [], "subagent");
			assert.equal(typeof refused, "string", name);
			assert.match(
				refused as string,
				new RegExp(`^Unknown tools: ${name}\\. Choose from your own tools: read, bash, codemode, powershell\\.$`),
			);
		}
	});

	it("gives only what a limited caller has", () => {
		const limited = { tools: pick("read"), deferred: [], callable: pick("read") };
		const choice = resolveTools(limited, access, undefined, [], "one-shot");
		assert(typeof choice !== "string");
		assert.deepEqual(names(choice.tools), ["read"]);
		assert.equal(typeof resolveTools(limited, access, ["bash"], [], "one-shot"), "string");
	});
});
