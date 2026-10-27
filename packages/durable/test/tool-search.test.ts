import { type AssistantMessage, fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type Conversation,
	defineExtension,
	defineTool,
	type EntryRecord,
	type JsonObject,
	MemoryStorage,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { createToolSearchExtension } from "../src/tool-search/index.ts";
import { allEntries, type ChatSetup, chatSetup, openChat } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";

function tool(name: string, description: string, extra: Partial<ToolRegistration> = {}): ToolRegistration {
	return defineTool({
		name,
		description,
		parameters: Type.Object({ number: Type.Optional(Type.Number({ description: "Issue number" })) }),
		execute: async () => ({ output: [{ type: "text", text: `${name} ran` }] }),
		...extra,
	});
}

const DONE = fauxAssistantMessage([fauxText("done")]);

function call(name: string, args: JsonObject = {}, id = "c1"): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
}

/** `alpha`, the deferred `github_get_issue` and `github_list_repos`, then `omega`, and `tool_search` last. */
function setup(): ChatSetup {
	const chat = chatSetup();
	addTool(chat.registry, tool("alpha", "Alpha tool"));
	addTool(chat.registry, tool("github_get_issue", "Get a GitHub issue by number", { deferred: true }));
	addTool(chat.registry, tool("github_list_repos", "List the repositories of a user", { deferred: true }));
	addTool(chat.registry, tool("omega", "Omega tool"));
	chat.registry.install(createToolSearchExtension());
	return chat;
}

async function offered(root: Conversation): Promise<string[]> {
	return (await root.agent(context)).tools.map((each) => each.name);
}

/** The model messages of the `pi.system` entries, oldest first. */
function systemMessages(entries: readonly EntryRecord[]) {
	return entries
		.filter((entry) => entry.kind === "pi.system")
		.map((entry) => entry.model![0] as { toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] });
}

function toolResultTexts(entries: readonly EntryRecord[]): string[] {
	return entries
		.filter((entry) => entry.kind === "pi.tool-result")
		.map((entry) => (entry.model![0] as { content: { text?: string }[] }).content.map((item) => item.text).join(""));
}

describe("deferred tools and tool_search", () => {
	it("offers a deferred tool only once tool_search loads it, by appending its declaration", async () => {
		const chat = setup();
		chat.faux.setResponses([
			call("tool_search", { query: "github issue", limit: 1 }),
			call("github_get_issue", { number: 42 }, "c2"),
			DONE,
		]);
		const { harness, root } = await openChat(new MemoryStorage(), chat);
		expect(await offered(root)).toEqual(["alpha", "omega", "tool_search"]);
		expect((await root.agent(context)).deferred.map((each) => each.name)).toEqual([
			"github_get_issue",
			"github_list_repos",
		]);
		// Deferred tools stay callable by other tools, such as code mode scripts.
		expect((await root.agent(context)).callable.map((each) => each.name)).toContain("github_get_issue");
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const entries = await allEntries(root);
		const [search, issue] = toolResultTexts(entries);
		expect(search).toBe(
			"Loaded 1 tool. They are available from your next call:\n- github_get_issue: Get a GitHub issue by number",
		);
		expect(issue).toBe("github_get_issue ran");
		expect((await harness.snapshot(AgentDoc, root.id, context))?.modelTools).toEqual({ add: ["github_get_issue"] });
		expect(await offered(root)).toEqual(["alpha", "omega", "tool_search", "github_get_issue"]);
		// A later search sees only the tools not loaded yet.
		expect((await root.agent(context)).deferred.map((each) => each.name)).toEqual(["github_list_repos"]);
		// The load appended the declaration: no tool was removed and declared again, so the cached prefix holds.
		const [baseline, load] = systemMessages(entries);
		expect(baseline!.toolsAdded!.map((each) => each.name)).toEqual(["alpha", "omega", "tool_search"]);
		expect(load).toEqual(
			expect.objectContaining({ toolsAdded: [expect.objectContaining({ name: "github_get_issue" })] }),
		);
		expect(load!.toolsRemoved).toBeUndefined();
		await harness.close(context);
	});

	it("appends each loaded tool in load order, not registry order", async () => {
		const chat = setup();
		chat.faux.setResponses([
			call("tool_search", { query: "repositories", limit: 1 }),
			call("tool_search", { query: "issue", limit: 1 }, "c2"),
			DONE,
		]);
		const { harness, root } = await openChat(new MemoryStorage(), chat);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(await offered(root)).toEqual(["alpha", "omega", "tool_search", "github_list_repos", "github_get_issue"]);
		const loads = systemMessages(await allEntries(root)).slice(1);
		expect(loads.map((message) => message.toolsAdded?.map((each) => each.name))).toEqual([
			["github_list_repos"],
			["github_get_issue"],
		]);
		expect(loads.every((message) => message.toolsRemoved === undefined)).toBe(true);
		await harness.close(context);
	});

	it("records loads by name: unknown and non-deferred names change nothing, remove wins, and a load lifts it", async () => {
		const chat = setup();
		const grow = defineTool({
			name: "grow",
			description: "grow",
			parameters: Type.Object({}),
			execute: async () => ({ output: [], control: { addTools: ["github_get_issue", "alpha", "ghost"] } }),
		});
		addTool(chat.registry, grow);
		chat.faux.setResponses([call("grow"), DONE, call("grow"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), chat);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect((await harness.snapshot(AgentDoc, root.id, context))?.modelTools).toEqual({
			add: ["github_get_issue", "alpha", "ghost"],
		});
		expect(await offered(root)).toEqual(["alpha", "omega", "tool_search", "grow", "github_get_issue"]);
		// A name in both remove and add is not offered.
		const [getIssue] = (await root.agent(context)).callable.filter((each) => each.name === "github_get_issue");
		await root.configure({ modelTools: { remove: [getIssue!], add: [getIssue!] } }, context);
		expect(await offered(root)).not.toContain("github_get_issue");
		// Loading it again drops it from remove.
		await (await root.submit({ type: "input", content: "again" }, context)).wait(context);
		expect((await harness.snapshot(AgentDoc, root.id, context))?.modelTools).toEqual({
			add: ["github_get_issue", "alpha", "ghost"],
		});
		expect(await offered(root)).toContain("github_get_issue");
		await harness.close(context);
	});

	it("keeps a loaded tool when its extension is gone for a while, and appends to an explicit array", async () => {
		const chat = setup();
		const issue = tool("github_get_issue", "Get a GitHub issue by number", { deferred: true });
		chat.faux.setResponses([call("tool_search", { query: "github issue", limit: 1 }), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), chat);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		// The server goes away: its extension is installed again without the tool.
		chat.registry.install(defineExtension({ name: "tool:github_get_issue", tools: [] }));
		expect(await offered(root)).not.toContain("github_get_issue");
		chat.registry.install(defineExtension({ name: "tool:github_get_issue", tools: [issue] }));
		expect(await offered(root)).toContain("github_get_issue");
		// With an explicit array, a load appends to it as before.
		const alpha = (await root.agent(context)).tools.find((each) => each.name === "alpha")!;
		const search = (await root.agent(context)).tools.find((each) => each.name === "tool_search")!;
		await root.configure({ modelTools: [alpha, search] }, context);
		chat.faux.setResponses([call("tool_search", { query: "repositories", limit: 1 }), DONE]);
		await (await root.submit({ type: "input", content: "more" }, context)).wait(context);
		expect((await harness.snapshot(AgentDoc, root.id, context))?.modelTools).toEqual([
			"alpha",
			"tool_search",
			"github_list_repos",
		]);
		await harness.close(context);
	});

	it("keeps loaded tools per branch and in the baseline after a reset", async () => {
		const chat = setup();
		chat.faux.setResponses([call("tool_search", { query: "github issue", limit: 1 }), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), chat);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const entries = await allEntries(root);
		const before = await root.fork(entries[0]!.id, { ownership: { kind: "ownerless" } }, context);
		const after = await root.fork(entries.at(-1)!.id, { ownership: { kind: "ownerless" } }, context);
		expect(await offered(before)).not.toContain("github_get_issue");
		expect(await offered(after)).toContain("github_get_issue");
		await root.reset(undefined, context);
		chat.faux.setResponses([DONE]);
		await (await root.submit({ type: "input", content: "fresh" }, context)).wait(context);
		const baseline = systemMessages(await allEntries(root)).at(-1)!;
		expect(baseline.toolsAdded!.map((each) => each.name)).toEqual([
			"alpha",
			"omega",
			"tool_search",
			"github_get_issue",
		]);
		await harness.close(context);
	});

	it("finds nothing for an unrelated query and loads nothing", async () => {
		const chat = setup();
		chat.faux.setResponses([call("tool_search", { query: "weather forecast" }), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), chat);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(toolResultTexts(await allEntries(root))).toEqual(["No matching tools found."]);
		expect((await harness.snapshot(AgentDoc, root.id, context))?.modelTools).toBeUndefined();
		await harness.close(context);
	});
});
