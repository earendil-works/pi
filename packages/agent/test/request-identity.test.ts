import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { getAgentRequestIdentity } from "../src/request-metadata.ts";
import { calculateTool } from "./utils/calculate.ts";

const registrations: Array<ReturnType<typeof registerFauxProvider>> = [];
type RequestIdentity = NonNullable<ReturnType<typeof getAgentRequestIdentity>>;

afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

describe("Agent request identity", () => {
	// #9481
	it("shares one identity across tools and rotates it for a follow-up", async () => {
		const faux = registerFauxProvider();
		registrations.push(faux);
		const identities: RequestIdentity[] = [];
		let agent: Agent;
		faux.setResponses([
			(_context, options) => {
				identities.push(getAgentRequestIdentity(options?.metadata)!);
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" }));
			},
			(_context, options) => {
				identities.push(getAgentRequestIdentity(options?.metadata)!);
				agent.followUp({ role: "user", content: "next", timestamp: Date.now() });
				return fauxAssistantMessage("4");
			},
			(_context, options) => {
				identities.push(getAgentRequestIdentity(options?.metadata)!);
				return fauxAssistantMessage("done");
			},
		]);
		agent = new Agent({
			sessionId: "session",
			streamFn: streamSimple,
			initialState: { model: faux.getModel(), tools: [calculateTool] },
		});

		await agent.prompt("start");

		expect(identities[1]).toEqual(identities[0]);
		expect(identities[2].turnId).not.toBe(identities[0].turnId);
		expect(identities[0]).toMatchObject({
			threadId: "session",
			requestKind: "turn",
		});
		expect(identities[0].sessionId).toBe(identities[0].threadId);
	});

	// #9481
	it("keeps steering within the active turn identity", async () => {
		const faux = registerFauxProvider();
		registrations.push(faux);
		const identities: RequestIdentity[] = [];
		let agent: Agent;
		faux.setResponses([
			(_context, options) => {
				identities.push(getAgentRequestIdentity(options?.metadata)!);
				agent.steer({ role: "user", content: "redirect", timestamp: Date.now() });
				return fauxAssistantMessage("first");
			},
			(_context, options) => {
				identities.push(getAgentRequestIdentity(options?.metadata)!);
				return fauxAssistantMessage("redirected");
			},
		]);
		agent = new Agent({
			sessionId: "session",
			streamFn: streamSimple,
			initialState: { model: faux.getModel() },
		});

		await agent.prompt("start");

		expect(identities[1]).toEqual(identities[0]);
	});

	// #9481
	it("preserves session and thread identity when recreating an agent", async () => {
		const faux = registerFauxProvider();
		registrations.push(faux);
		const identities: RequestIdentity[] = [];
		faux.setResponses([
			(_context, options) => {
				identities.push(getAgentRequestIdentity(options?.metadata)!);
				return fauxAssistantMessage("done");
			},
			(_context, options) => {
				identities.push(getAgentRequestIdentity(options?.metadata)!);
				return fauxAssistantMessage("done");
			},
		]);
		const first = new Agent({
			sessionId: "session",
			streamFn: streamSimple,
			initialState: { model: faux.getModel() },
		});
		const second = new Agent({
			sessionId: "session",
			streamFn: streamSimple,
			initialState: { model: faux.getModel() },
		});

		await first.prompt("first");
		await second.prompt("second");

		expect(identities[0]).toMatchObject({ sessionId: "session", threadId: "session" });
		expect(identities[1]).toMatchObject({ sessionId: "session", threadId: "session" });
		expect(identities[1].turnId).not.toBe(identities[0].turnId);
	});

	// #9481
	it("preserves identity when continuing a failed request", async () => {
		const faux = registerFauxProvider();
		registrations.push(faux);
		const identities: RequestIdentity[] = [];
		faux.setResponses([
			(_context, options) => {
				identities.push(getAgentRequestIdentity(options?.metadata)!);
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "retry" });
			},
			(_context, options) => {
				identities.push(getAgentRequestIdentity(options?.metadata)!);
				return fauxAssistantMessage("done");
			},
		]);
		const agent = new Agent({
			sessionId: "session",
			streamFn: streamSimple,
			initialState: { model: faux.getModel() },
		});

		await agent.prompt("start");
		agent.state.messages = agent.state.messages.slice(0, -1);
		await agent.continue();

		expect(identities[1]).toEqual(identities[0]);
	});
});
