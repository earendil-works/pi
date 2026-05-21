import { getModel, getModels, type Model } from "@earendil-works/pi-ai";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.js";

/**
 * E2E test for the a1-browser-server-agent-swarm proxy endpoint.
 * Uses Agent from pi-agent-core, following the same pattern as
 * eko/apps/server/src/services/client-agent/index.ts:createAgent().
 *
 * Prerequisites:
 *   cd d:\code\a1-browser-server-agent-swarm\src
 *   uvicorn main:app --host 0.0.0.0 --port 8080
 */

const SERVER_RUNNING = await (async () => {
	try {
		const r = await fetch("http://localhost:8080/api/v1/ping", {
			signal: AbortSignal.timeout(2000),
		});
		return r.ok || r.status === 404;
	} catch {
		return false;
	}
})();

// Auth fields the proxy requires (mirrors LLMConfigBridge.config.serverParams in eko)
const serverParams = {
	user_id: "17733891307440",
	company_id: "17515416458002",
	machine_str: "509ddcfa9220c24dc2c5ff3ebc56d09f_v1",
	client_version: "6.25.22.57",
	session_id: "06a0e8a1-5d18-7df6-8000-247a2575dd7a",
	from_trace_id: "06a0d943-6d85-7049-8000-f5424ff1da81",
	scene_type: 3,
	provider: "openai",
	model: "qwen3.5-plus",
};

/**
 * Build proxy model following LLMConfigBridge.getModel() in llm-bridge.ts.
 *
 * 'qwen3.5-plus' is not a known pi-ai model, so we fall back to the cerebras
 * template (openai-completions API) and override id/name/baseUrl — exactly
 * as getModel() does when provider === 'openai' and a custom baseUrl is set.
 */
function buildProxyModel(modelId: string, baseUrl: string): Model<any> {
	// Try exact match first (will be null for custom model IDs)
	let model: Model<any> | undefined = getModel("openai" as any, modelId as any);
	if (!model) {
		// provider === 'openai' + custom baseUrl → use cerebras template (openai-completions)
		const [template] = getModels("cerebras");
		model = { ...template, id: modelId, name: modelId };
	}
	return { ...model, baseUrl };
}

const proxyModel = buildProxyModel("qwen3.5-plus", "http://localhost:8080/api/v1/system/llm");

/**
 * Wrap every outgoing LLM payload for the proxy.
 * Mirrors LLMConfigBridge.getAgentOptions() in eko/apps/server/src/services/client-agent/llm-bridge.ts:
 *   { llm_param: <openai-params>, ...serverParams }
 *
 * IMPORTANT: keep `stream` at the top level so the OpenAI SDK stays in streaming
 * mode and returns a real Stream<ChatCompletionChunk> (not a raw SSE string body).
 * The proxy reads `stream` from llm_param, not the top level — so this is safe.
 */
const onPayload = async (payload: unknown) => {
	const p = payload as Record<string, unknown>;
	const wrapped: Record<string, unknown> = {
		llm_param: p,
		...serverParams,
	};
	// Preserve stream flag at top level for the OpenAI SDK client
	if (p.stream !== undefined) wrapped.stream = p.stream;
	return wrapped;
};

// File root for coding tools (mirrors index.ts createAgent() fileRoot)
const fileRoot = process.cwd();

const tools = [createReadTool(fileRoot), createWriteTool(fileRoot), createEditTool(fileRoot)];

describe.skipIf(!SERVER_RUNNING)("Zixun Proxy E2E (via Agent)", () => {
	it("agent.prompt() returns a non-empty assistant response", async () => {
		// Mirrors index.ts createAgent() pattern
		const agent = new Agent({
			initialState: {
				systemPrompt: "You are a helpful assistant.",
				model: proxyModel,
				tools,
			},
			getApiKey: () =>
				"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3NzkyNzQ3OTksIm5iZiI6MTc3OTI3NDc5OSwiZXhwIjoxNzgwNTcwMDQ3LCJzdWIiOiJhdXRoIiwiaXNzIjoiYWdlbnQueml4dW4uYWkiLCJhdWQiOiJhZ2VudC56aXh1bi5haSIsImRhdGEiOnsiY29tcGFueV9pZCI6IjE3NTE1NDE2NDU4MDAyIiwidXNlcl9pZCI6IjE3NzMzODkxMzA3NDQwIiwicGg1IjoiMmE0MWJjZjU0ZTFjNzFjZDgwNjE3YzJkZTIyNjhiOWUifX0.Qw-cMiQGxHmBZ5SnFEBoGVgDYopDJpaGbF31JfTxMvM", // proxy handles auth via serverParams
			onPayload,
			sessionId: serverParams.session_id,
		});

		await agent.prompt("请用 read 工具读取 package.json，然后告诉我这个包的名字和版本号");

		expect(agent.state.isStreaming).toBe(false);
		// user → assistant(tool_call) → tool_result → assistant(final)
		expect(agent.state.messages.length).toBeGreaterThanOrEqual(3);

		const lastMsg = agent.state.messages.at(-1)!;
		expect(lastMsg.role).toBe("assistant");
		if (lastMsg.role !== "assistant") throw new Error("Expected assistant");

		const text = lastMsg.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("");
		console.log("tool response:", text.slice(0, 300));
		expect(text.length).toBeGreaterThan(0);
	}, 60_000);

	it("agent events include text_delta during streaming", async () => {
		const agent = new Agent({
			initialState: {
				systemPrompt: "You are a helpful assistant.",
				model: proxyModel,
				tools,
			},
			getApiKey: () =>
				"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3NzkyNzQ3OTksIm5iZiI6MTc3OTI3NDc5OSwiZXhwIjoxNzgwNTcwMDQ3LCJzdWIiOiJhdXRoIiwiaXNzIjoiYWdlbnQueml4dW4uYWkiLCJhdWQiOiJhZ2VudC56aXh1bi5haSIsImRhdGEiOnsiY29tcGFueV9pZCI6IjE3NTE1NDE2NDU4MDAyIiwidXNlcl9pZCI6IjE3NzMzODkxMzA3NDQwIiwicGg1IjoiMmE0MWJjZjU0ZTFjNzFjZDgwNjE3YzJkZTIyNjhiOWUifX0.Qw-cMiQGxHmBZ5SnFEBoGVgDYopDJpaGbF31JfTxMvM", // proxy handles auth via serverParams
			onPayload,
			sessionId: serverParams.session_id,
		});

		const deltas: string[] = [];
		const toolEvents: string[] = [];
		agent.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				deltas.push(event.assistantMessageEvent.delta);
			}
			if (event.type === "tool_execution_start") {
				toolEvents.push(`start:${event.toolName}`);
			}
			if (event.type === "tool_execution_end") {
				toolEvents.push(`end:${event.toolName}`);
			}
		});

		await agent.prompt("请用 read 工具读取 package.json，然后告诉我这个包的名字和版本号");

		const fullText = deltas.join("");
		console.log(`text_delta events: ${deltas.length}, text: ${fullText.slice(0, 200)}`);
		console.log("tool events:", toolEvents.join(", "));
		expect(toolEvents.some((e) => e.startsWith("start:"))).toBe(true);
		expect(deltas.length).toBeGreaterThan(0);
		expect(fullText.length).toBeGreaterThan(0);
	}, 60_000);
});
