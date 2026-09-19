import {
	fauxAssistantMessage,
	type ImageContent,
	registerFauxProvider,
	streamSimple,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";

// #9340: test at the actual queue owner, not a reconstructed session display queue.
describe("#9340 queue ownership", () => {
	it.each(["steer", "followUp"] as const)(
		"Given reserved %s originals, When preparation aborts, Then FIFO objects survive for a fresh prompt",
		async (kind) => {
			for (const mode of ["one-at-a-time", "all"] as const) {
				for (const clear of [false, true]) {
					const faux = registerFauxProvider();
					const image: ImageContent = { type: "image", mimeType: "image/png", data: "eA==" };
					const originals: UserMessage[] = [1, 2].map((n) => ({
						role: "user",
						content: [{ type: "text", text: `queued-${n}` }, image],
						timestamp: n,
					}));
					const agent = new Agent({
						streamFn: streamSimple,
						initialState: { model: faux.getModel() },
						steeringMode: mode,
						followUpMode: mode,
					});
					let first = true;
					agent.subscribe((e) => {
						if (e.type === "turn_end" && first) {
							first = false;
							for (const m of originals) agent[kind](m);
						}
					});
					agent.prepareNextTurn = () => {
						agent.abort();
						if (clear) agent.clearAllQueues();
						return undefined;
					};
					try {
						faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("unexpected")]);
						await agent.prompt("old");
						expect(faux.state.callCount).toBe(1);
						for (const m of originals) expect(agent.state.messages).not.toContain(m);
						expect(agent.hasQueuedMessages()).toBe(!clear);
						agent.prepareNextTurn = undefined;
						const delivered: unknown[] = [];
						faux.setResponses(
							Array.from({ length: 4 }, () => (context) => {
								delivered.push(context.messages);
								return fauxAssistantMessage("ok");
							}),
						);
						await agent.prompt("fresh");
						const users = agent.state.messages.filter((m) => m.role === "user");
						expect(users.slice(2)).toEqual(clear ? [] : originals);
						for (const m of originals) expect(users.filter((u) => u === m)).toHaveLength(clear ? 0 : 1);
						expect(JSON.stringify(delivered).includes("queued-1")).toBe(!clear);
						expect(agent.hasQueuedMessages()).toBe(false);
					} finally {
						faux.unregister();
					}
				}
			}
		},
	);

	it("Given an all-mode batch, When stopped after accepting its first message, Then accepted input stays and only the remainder is restored", async () => {
		const faux = registerFauxProvider();
		const agent = new Agent({
			streamFn: streamSimple,
			initialState: { model: faux.getModel() },
			steeringMode: "all",
		});
		const accepted: UserMessage = { role: "user", content: "accepted", timestamp: 1 };
		const pending: UserMessage = { role: "user", content: "pending", timestamp: 2 };
		agent.steer(accepted);
		agent.steer(pending);
		const unsubscribe = agent.subscribe((e) => {
			if (e.type === "message_end" && e.message === accepted) agent.abort();
		});
		try {
			faux.setResponses([fauxAssistantMessage("unexpected")]);
			await agent.prompt("old");
			expect(faux.state.callCount).toBe(0);
			expect(agent.state.messages).toContain(accepted);
			expect(agent.state.messages).not.toContain(pending);
			unsubscribe();
			faux.setResponses([fauxAssistantMessage("fresh")]);
			await agent.prompt("fresh");
			expect(agent.state.messages.filter((m) => m === accepted)).toHaveLength(1);
			expect(agent.state.messages.filter((m) => m === pending)).toHaveLength(1);
			expect(agent.hasQueuedMessages()).toBe(false);
		} finally {
			faux.unregister();
		}
	});

	it("Given a completed response with queued steer, When message_end aborts, Then the original is not polled or delivered", async () => {
		const faux = registerFauxProvider();
		const agent = new Agent({ streamFn: streamSimple, initialState: { model: faux.getModel() } });
		const queued: UserMessage = { role: "user", content: "pending", timestamp: 1 };
		agent.subscribe((e) => {
			if (e.type === "message_end" && e.message.role === "assistant") {
				agent.steer(queued);
				agent.abort();
			}
		});
		try {
			faux.setResponses([fauxAssistantMessage("completed stopReason stop")]);
			await agent.prompt("old");
			expect(faux.state.callCount).toBe(1);
			expect(agent.state.messages).not.toContain(queued);
			expect(agent.hasQueuedMessages()).toBe(true);
		} finally {
			faux.unregister();
		}
	});
});
