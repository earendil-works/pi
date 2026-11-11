import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { type OpenAIResponsesOptions, stream } from "../src/api/openai-responses.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	getResponsesToolNamespaces,
} from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-6.1-sol",
	name: "GPT-6.1 Sol",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000000,
	maxTokens: 1024,
	compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsOpenAIGrammarTools: true },
};
const tool = (name: string): Tool => ({
	name,
	description: `Run ${name}`,
	parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
});
const tools = [
	tool("read"),
	tool("records_get"),
	tool("records__list"),
	tool("chat.send"),
	tool("chat-read"),
	tool("inspect"),
];
const deferred = new Set(tools.slice(1).map((tool) => tool.name));

async function capture(toolSearch?: OpenAIResponsesOptions["toolSearch"]) {
	let payload: ResponseCreateParamsStreaming | undefined;
	const result = await stream(
		model,
		normalizeContext({
			tools,
			messages: [
				{ role: "user", content: "Get a record", timestamp: 0 },
				{ role: "system", content: "Later instructions", toolsAdded: [tool("extra_get")], timestamp: 1 },
			],
		}),
		{
			apiKey: "test-key",
			toolSearch,
			maxRetries: 0,
			fetch: async (_url, init) => {
				payload = JSON.parse(String(init?.body)) as ResponseCreateParamsStreaming;
				return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n', {
					headers: { "content-type": "text/event-stream" },
				});
			},
		},
	).result();
	expect(result.stopReason).toBe("stop");
	return payload!;
}

describe("Responses deferred tool namespaces", () => {
	it("retains client tool additions when hosted search is not requested", async () => {
		const payload = await capture();
		expect(payload.tools).toBeUndefined();
		expect(payload.input).toEqual(expect.arrayContaining([expect.objectContaining({ type: "additional_tools" })]));
	});
	it("keeps ordinary tool conversion unchanged by default", () => {
		const converted = convertResponsesTools(tools);
		expect(converted.map((tool) => tool.type)).toEqual(tools.map(() => "function"));
		for (const tool of converted) expect(tool).not.toHaveProperty("defer_loading");
	});

	it("groups only deferred tools and preserves their full names and schemas", () => {
		const namespaces = getResponsesToolNamespaces(tools, deferred);
		const converted = convertResponsesTools(tools, { deferredToolNames: deferred, namespaces });
		expect(converted.map((tool) => tool.type)).toEqual(["function", "namespace", "namespace", "namespace"]);
		expect(converted[0]).toMatchObject({ name: "read" });
		expect(converted[0]).not.toHaveProperty("defer_loading");
		const members = converted.flatMap((tool) => (tool.type === "namespace" ? tool.tools : []));
		expect(members).toEqual(convertResponsesTools(tools.slice(1), { deferredToolNames: deferred }));
		expect([...namespaces]).toEqual([
			["records_get", "records"],
			["records__list", "records"],
			["chat.send", "chat"],
			["chat-read", "chat"],
			["inspect", "tools"],
		]);
	});

	it("avoids eager names, fallback names, and truncated namespace collisions deterministically", () => {
		const names = [
			"records",
			"records_tools",
			"tools",
			"tools_tools",
			"records_get",
			"inspect",
			`${"x".repeat(65)}_get`,
			`${"x".repeat(64)}y_get`,
		];
		const catalog = names.map(tool);
		const deferred = new Set(names.slice(4));
		const result = getResponsesToolNamespaces(catalog, deferred);
		expect(result.get("records_get")).toBe("records_tools2");
		expect(result.get("inspect")).toBe("tools_tools2");
		expect(new Set(result.values()).size).toBe(4);
		for (const name of result.values()) expect(name.length).toBeLessThanOrEqual(64);
		expect(getResponsesToolNamespaces(catalog, deferred)).toEqual(result);
	});

	it("keeps strict JSON schemas and grammar tools inside their namespaces", () => {
		const strict: Tool = { ...tool("records_get"), constrainedSampling: { type: "json_schema", strict: "require" } };
		const grammar: Tool = {
			...tool("records_query"),
			constrainedSampling: { type: "grammar", variants: { openai_regex: ".*" } },
		};
		const catalog = [strict, grammar];
		const deferred = new Set(catalog.map((tool) => tool.name));
		const converted = convertResponsesTools(catalog, {
			deferredToolNames: deferred,
			namespaces: getResponsesToolNamespaces(catalog, deferred),
			supportsOpenAIGrammarTools: true,
		});
		expect(converted[0]).toMatchObject({
			type: "namespace",
			name: "records",
			tools: [
				{
					type: "function",
					name: "records_get",
					strict: true,
					defer_loading: true,
					parameters: { additionalProperties: false },
				},
				{ type: "custom", name: "records_query", defer_loading: true, format: { type: "grammar" } },
			],
		});
	});

	it("declares hosted search once with a stable current catalog instead of client additions", async () => {
		const payload = await capture({ deferredTools: [...deferred, "extra_get"], namespace: "prefix" });
		expect(payload.tools?.filter((tool) => tool.type === "tool_search")).toHaveLength(1);
		expect(payload.tools?.filter((tool) => tool.type === "namespace").map((tool) => tool.name)).toEqual([
			"records",
			"chat",
			"tools",
			"extra",
		]);
		expect(payload.input).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "additional_tools" })]),
		);
		expect(payload.input).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "tool_search_call" })]),
		);
	});

	it("allows flat deferral and does not enable search for unmatched tool names", async () => {
		const flat = await capture({ deferredTools: ["records_get"] });
		expect(flat.tools).toEqual(
			expect.arrayContaining([
				{ type: "tool_search" },
				expect.objectContaining({ type: "function", name: "records_get", defer_loading: true }),
			]),
		);
		expect(flat.tools?.some((tool) => tool.type === "namespace")).toBe(false);
		const unmatched = await capture({ deferredTools: ["missing"], namespace: "prefix" });
		expect(unmatched.tools?.every((tool) => tool.type === "function")).toBe(true);
	});

	it("preserves received namespaces and supplies declared namespaces on foreign calls", () => {
		const source: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_test|fc_test",
					name: "records_get",
					arguments: { value: "x" },
					namespace: "loaded_records",
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "toolUse",
			timestamp: 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const toolNamespaces = getResponsesToolNamespaces(tools, deferred);
		for (const foreign of [false, true]) {
			const input = convertResponsesMessages(
				model,
				normalizeContext({ messages: [{ ...source, model: foreign ? "other" : model.id }] }),
				new Set(["openai"]),
				{ toolNamespaces },
			);
			expect(input.find((item) => item.type === "function_call")).toMatchObject({
				namespace: foreign ? "records" : "loaded_records",
			});
		}
		expect(source.content[0]).toMatchObject({ namespace: "loaded_records" });
	});
});
