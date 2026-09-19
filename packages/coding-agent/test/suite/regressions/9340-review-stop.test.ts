import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { createHarness, getUserTexts } from "../harness.ts";

function gate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

// #9340: consolidated-review counterexamples for contract cases 4, 5 and 9.
it.each([false, true])(
	"Given pre-prompt compaction, When stopped and flushed (delayed=%s), Then input waits for an explicit fresh prompt",
	async (delayed) => {
		const entered = gate(),
			release = gate(),
			input = gate();
		const h = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: {
				compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1 },
				retry: { enabled: false },
			},
			tools: [],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						entered.release();
						await release.promise;
						return { cancel: true };
					});
					pi.on("input", async (e) => {
						if (e.text === "flushed" && delayed) await input.promise;
					});
				},
			],
		});
		try {
			for (let i = 0; i < 3; i++) {
				h.sessionManager.appendMessage({ role: "user", content: `history ${i}`, timestamp: i });
				h.sessionManager.appendMessage({
					...fauxAssistantMessage(`response ${i}`),
					api: h.getModel().api,
					provider: h.getModel().provider,
					model: h.getModel().id,
					usage: {
						input: 2400,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2401,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				});
			}
			h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
			h.setResponses([fauxAssistantMessage("unsolicited")]);
			let flushed: Promise<void> | undefined;
			const off = h.session.subscribe((e) => {
				if (e.type === "compaction_end") flushed = h.session.prompt("flushed", { streamingBehavior: "steer" });
			});
			const run = h.session.prompt("original").catch((e: Error) => e.message);
			await entered.promise;
			expect(h.session.isStreaming).toBe(false);
			const stopped = h.session.abort();
			h.session.setAutoCompactionEnabled(false);
			release.release();
			expect(await run).toBe("Prompt cancelled");
			input.release();
			await flushed;
			await stopped;
			off();
			expect(h.faux.state.callCount).toBe(0);
			expect(h.session.pendingMessageCount).toBe(1);
			expect(getUserTexts(h)).not.toContain("flushed");
			let requestUsers: unknown[] = [];
			h.setResponses([
				(context) => {
					requestUsers = context.messages.filter((m) => m.role === "user");
					return fauxAssistantMessage("fresh");
				},
			]);
			await h.session.prompt("fresh");
			expect(h.faux.state.callCount).toBe(1);
			expect(JSON.stringify(requestUsers)).toContain("flushed");
			expect(getUserTexts(h).slice(-2)).toEqual(["fresh", "flushed"]);
			expect(h.session.pendingMessageCount).toBe(0);
		} finally {
			h.cleanup();
		}
	},
);

it.each(["steer", "followUp"] as const)(
	"Given an initial %s continuation batch, When stopped or cleared at acceptance boundaries, Then only accepted originals persist",
	async (kind) => {
		for (const boundary of ["agent_start", "turn_start", "message_end"] as const) {
			for (const clear of [false, true]) {
				const faux = registerFauxProvider();
				const agent = new Agent({
					streamFn: streamSimple,
					initialState: { model: faux.getModel() },
					steeringMode: "all",
					followUpMode: "all",
				});
				const originals: AgentMessage[] = [1, 2].map((n) => ({
					role: "user",
					content: [
						{ type: "text", text: `q${n}` },
						{ type: "image", mimeType: "image/png", data: "eA==" },
					],
					timestamp: n,
				}));
				try {
					faux.setResponses([fauxAssistantMessage("seed")]);
					await agent.prompt("seed");
					for (const m of originals) agent[kind](m);
					const off = agent.subscribe((e) => {
						if (e.type === boundary && (e.type !== "message_end" || e.message === originals[0])) {
							agent.abort();
							if (clear) agent.clearAllQueues();
						}
					});
					await agent.continue();
					off();
					expect(faux.state.callCount).toBe(1);
					const accepted = boundary === "message_end" ? [originals[0]] : [];
					expect(agent.state.messages.filter((m) => originals.includes(m))).toEqual(accepted);
					expect(agent.hasQueuedMessages()).toBe(!clear);
					const delivered: string[] = [];
					faux.setResponses(
						Array.from({ length: 3 }, () => (context) => {
							delivered.push(JSON.stringify(context.messages));
							return fauxAssistantMessage("fresh");
						}),
					);
					await agent.prompt("fresh");
					const expected = clear ? accepted : originals;
					expect(agent.state.messages.filter((m) => originals.includes(m))).toEqual(expected);
					for (const m of expected)
						expect(agent.state.messages.filter((candidate) => candidate === m)).toHaveLength(1);
					expect(delivered.some((m) => m.includes("q2"))).toBe(!clear);
					expect(agent.hasQueuedMessages()).toBe(false);
				} finally {
					faux.unregister();
				}
			}
		}
	},
);

it.each(["steer", "followUp"] as const)(
	"Given reserved %s input, When preparation clears without abort, Then cleared originals never reach the transcript or provider",
	async (kind) => {
		for (const mode of ["all", "one-at-a-time"] as const) {
			const faux = registerFauxProvider();
			const agent = new Agent({
				streamFn: streamSimple,
				initialState: { model: faux.getModel() },
				steeringMode: mode,
				followUpMode: mode,
			});
			const queued: AgentMessage = { role: "user", content: "cleared", timestamp: 1 };
			let once = true;
			agent.subscribe((e) => {
				if (e.type === "turn_end" && once) {
					once = false;
					agent[kind](queued);
				}
			});
			agent.prepareNextTurn = () => {
				agent.clearAllQueues();
				return undefined;
			};
			try {
				let request = "";
				faux.setResponses([
					fauxAssistantMessage("first"),
					(context) => {
						request = JSON.stringify(context.messages);
						return fauxAssistantMessage("second");
					},
				]);
				await agent.prompt("seed");
				expect(agent.state.messages).not.toContain(queued);
				expect(request).not.toContain("cleared");
				expect(agent.hasQueuedMessages()).toBe(false);
			} finally {
				faux.unregister();
			}
		}
	},
);

it("Given queued system tool intent, When normalized for delivery, Then its reservation is accepted exactly once", async () => {
	const faux = registerFauxProvider();
	const agent = new Agent({ streamFn: streamSimple, initialState: { model: faux.getModel() } });
	const queued: AgentMessage = {
		role: "system",
		content: "queued system",
		timestamp: 1,
		toolsRemoved: [{ name: "missing" }],
	};
	try {
		agent.steer(queued);
		faux.setResponses([fauxAssistantMessage("one")]);
		await agent.prompt("seed");
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(faux.state.callCount).toBe(1);
		expect(agent.state.messages.filter((m) => m.role === "system")).toEqual([
			{ role: "system", content: "queued system", timestamp: 1 },
		]);
		expect(queued.toolsRemoved).toEqual([{ name: "missing" }]);
	} finally {
		faux.unregister();
	}
});

it.each([false, true])(
	"Given session queued continuation, When stopped at agent_start (clear=%s), Then queued originals remain unaccepted",
	async (clear) => {
		const h = await createHarness({
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			tools: [],
		});
		const originals: AgentMessage[] = [1, 2].map((n) => ({ role: "user", content: `session-q${n}`, timestamp: n }));
		let starts = 0,
			ends = 0,
			stopped: Promise<void> | undefined;
		h.session.setSteeringMode("all");
		const off = h.session.subscribe((e) => {
			if (e.type === "agent_end" && ++ends === 1) for (const m of originals) h.session.agent.steer(m);
			if (e.type === "agent_start" && ++starts === 2) {
				stopped = h.session.abort();
				if (clear) h.session.clearQueue();
			}
		});
		try {
			h.setResponses([fauxAssistantMessage("done")]);
			await h.session.prompt("seed");
			await stopped;
			off();
			expect(h.faux.state.callCount).toBe(1);
			for (const m of originals) expect(h.session.messages).not.toContain(m);
			expect(h.session.agent.hasQueuedMessages()).toBe(!clear);
			h.setResponses([fauxAssistantMessage("fresh")]);
			await h.session.prompt("fresh");
			expect(h.session.messages.filter((m) => originals.includes(m))).toEqual(clear ? [] : originals);
			expect(h.session.agent.hasQueuedMessages()).toBe(false);
		} finally {
			h.cleanup();
		}
	},
);

it("Given a normalized queued system message, When a session prompt settles, Then one request and one persisted copy suffice", async () => {
	const h = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		tools: [],
	});
	let stopped: Promise<void> | undefined;
	h.session.agent.steer({
		role: "system",
		content: "queued system",
		toolsRemoved: [{ name: "missing" }],
		timestamp: 1,
	});
	// Bound the broken implementation instead of letting its restoration loop run forever.
	h.session.subscribe((e) => {
		if (e.type === "agent_end" && h.faux.state.callCount >= 3) stopped = h.session.abort();
	});
	try {
		h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
		await h.session.prompt("seed");
		await stopped;
		expect(h.faux.state.callCount).toBe(1);
		expect(h.session.agent.hasQueuedMessages()).toBe(false);
		expect(
			h.sessionManager
				.getEntries()
				.filter(
					(e) => e.type === "message" && e.message.role === "system" && e.message.content === "queued system",
				),
		).toHaveLength(1);
	} finally {
		h.cleanup();
	}
});

it("Given an initial session follow-up batch, When stopped after its first message_end, Then only the remainder is restored", async () => {
	const h = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		tools: [],
	});
	const q1: AgentMessage = { role: "user", content: "accepted", timestamp: 1 },
		q2: AgentMessage = { role: "user", content: "unaccepted", timestamp: 2 };
	let ends = 0,
		stopped: Promise<void> | undefined;
	h.session.setFollowUpMode("all");
	const off = h.session.subscribe((e) => {
		if (e.type === "agent_end" && ++ends === 1) {
			h.session.agent.followUp(q1);
			h.session.agent.followUp(q2);
		}
		if (e.type === "message_end" && e.message === q1) stopped = h.session.abort();
	});
	try {
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("seed");
		await stopped;
		off();
		expect(h.session.messages).toContain(q1);
		expect(h.session.messages).not.toContain(q2);
		expect(h.session.agent.hasQueuedMessages()).toBe(true);
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
		h.setResponses([fauxAssistantMessage("fresh")]);
		await h.session.prompt("fresh");
		for (const m of [q1, q2]) expect(h.session.messages.filter((candidate) => candidate === m)).toHaveLength(1);
		expect(h.session.agent.hasQueuedMessages()).toBe(false);
	} finally {
		h.cleanup();
	}
});
