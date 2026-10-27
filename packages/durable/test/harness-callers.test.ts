import { type AssistantMessage, fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type Conversation,
	defineTool,
	MemoryStorage,
	type NestedToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { type ChatSetup, chatSetup, openChat } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";

function tool(name: string, extra: Partial<ToolRegistration> = {}): ToolRegistration {
	return defineTool({
		name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => ({ output: [{ type: "text", text: `${name} ran` }] }),
		...extra,
	});
}

const DONE = fauxAssistantMessage([fauxText("done")]);

function call(name: string, id = "c1"): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall(name, {}, { id })], { stopReason: "toolUse" });
}

/** A tool that calls each of `names` as a nested call and records what it got back. */
function prober(names: readonly string[]) {
	const received = new Map<string, NestedToolExecutionResult>();
	const registration = defineTool({
		name: "probe",
		description: "probe",
		parameters: Type.Object({}),
		execute: async (_args, api, callContext) => {
			for (const name of names) received.set(name, await api.executeTool(name, {}, callContext));
			return {};
		},
	});
	return { registration, received };
}

async function offered(root: Conversation): Promise<string[]> {
	return (await root.agent(context)).tools.map((each) => each.name);
}

async function callable(root: Conversation): Promise<string[]> {
	return (await root.agent(context)).callable.map((each) => each.name);
}

async function setupWith(tools: readonly ToolRegistration[]): Promise<ChatSetup> {
	const setup = chatSetup();
	for (const each of tools) addTool(setup.registry, each);
	return setup;
}

describe("who may call a tool", () => {
	it("offers the model only tools it may call, and lets tools call only tools they may call", async () => {
		const script = tool("script", { callers: ["model"] });
		const hidden = tool("hidden", { callers: ["tools"] });
		const both = tool("both");
		const probe = prober(["script", "hidden", "both"]);
		const setup = await setupWith([script, hidden, both, probe.registration]);
		setup.faux.setResponses([call("probe"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await offered(root)).toEqual(["script", "both", "probe"]);
		expect(await callable(root)).toEqual(["hidden", "both", "probe"]);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(probe.received.get("script")?.diagnostics[0]?.code).toBe("tool_unavailable");
		expect(probe.received.get("hidden")).toMatchObject({ isError: false, structuredOutput: "hidden ran" });
		expect(probe.received.get("both")).toMatchObject({ isError: false, structuredOutput: "both ran" });
		await harness.close(context);
	});

	it("narrows what the model is offered with modelTools, leaving the rest callable by tools", async () => {
		const read = tool("read");
		const bash = tool("bash");
		const probe = prober(["read", "bash"]);
		const setup = await setupWith([read, bash, probe.registration]);
		setup.faux.setResponses([call("probe"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.configure({ modelTools: [probe.registration] }, context);
		expect(await offered(root)).toEqual(["probe"]);
		expect(await callable(root)).toEqual(["read", "bash", "probe"]);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(probe.received.get("read")?.isError).toBe(false);
		expect(probe.received.get("bash")?.isError).toBe(false);

		await root.configure({ modelTools: { remove: [bash] } }, context);
		expect(await offered(root)).toEqual(["read", "probe"]);
		expect((await harness.snapshot(AgentDoc, root.id, context))?.modelTools).toEqual({ remove: ["bash"] });
		await root.configure({ modelTools: null }, context);
		expect(await offered(root)).toEqual(["read", "bash", "probe"]);
		await harness.close(context);
	});

	it("never offers a tool that is not enabled, nor lets tools call it", async () => {
		const read = tool("read");
		const bash = tool("bash");
		const probe = prober(["bash"]);
		const setup = await setupWith([read, bash, probe.registration]);
		setup.faux.setResponses([call("probe"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		// modelTools cannot bring back what tools disabled.
		await root.configure({ tools: { remove: [bash] }, modelTools: [bash, probe.registration] }, context);
		expect(await offered(root)).toEqual(["probe"]);
		expect(await callable(root)).toEqual(["read", "probe"]);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(probe.received.get("bash")?.diagnostics[0]?.code).toBe("tool_unavailable");
		await harness.close(context);
	});

	it("answers a model-issued call of a tool it was not offered as unavailable", async () => {
		const read = tool("read");
		const bash = tool("bash");
		const setup = await setupWith([read, bash]);
		setup.faux.setResponses([call("bash"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.configure({ modelTools: [read] }, context);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const entries = await root.entries({}, 100, undefined, context);
		const result = entries.items.find((entry) => entry.kind === "pi.tool-result");
		expect(JSON.stringify(result?.model)).toContain("Tool bash is not available");
		await harness.close(context);
	});

	it("applies addTools to modelTools too, so the model is offered the added tools", async () => {
		const extra = tool("extra");
		const grow = tool("grow", {
			execute: async () => ({ output: [], control: { addTools: ["extra"] } }),
		});
		const setup = await setupWith([extra, grow]);
		setup.faux.setResponses([call("grow"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.configure({ modelTools: [grow] }, context);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect((await harness.snapshot(AgentDoc, root.id, context))?.modelTools).toEqual(["grow", "extra"]);
		expect(await offered(root)).toEqual(["grow", "extra"]);
		await harness.close(context);
	});
});
