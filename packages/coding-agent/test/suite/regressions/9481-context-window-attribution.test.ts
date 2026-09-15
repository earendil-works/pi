import { join } from "node:path";
import { type AgentRequestIdentity, fauxAssistantMessage, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

// #9481: context windows follow committed compactions on the active branch, not summary requests.
describe("context-window attribution", () => {
	let harness: Harness;
	const sessions: AgentSession[] = [];
	const identities: AgentRequestIdentity[] = [];

	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		harness?.cleanup();
		identities.length = 0;
		vi.restoreAllMocks();
	});

	async function setup() {
		harness = await createHarness({
			settings: { retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } },
		});
		vi.spyOn(harness.session.modelRuntime, "streamSimple").mockImplementation((model, context, options) => {
			if (options?.requestIdentity) identities.push(options.requestIdentity);
			return streamSimple(model, context, options);
		});
	}

	async function openSession(manager: SessionManager, cancelCompaction = false) {
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("session_before_compact", () => (cancelCompaction ? { cancel: true } : undefined));
			},
		]);
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			sessionManager: manager,
			settingsManager: harness.settingsManager,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			tools: [],
		});
		sessions.push(session);
		return session;
	}

	it("reconstructs windows after resume, tree navigation, and a fork without changing retry identity", async () => {
		await setup();
		const manager = SessionManager.create(harness.tempDir, join(harness.tempDir, "sessions"));
		const session = await openSession(manager);
		harness.setResponses(Array.from({ length: 9 }, () => fauxAssistantMessage("ok")));
		await session.prompt("start");
		const rootLeaf = manager.getLeafId()!;
		const firstMessageId = manager.getBranch().find((entry) => entry.type === "message")!.id;
		const retryIdentity = session.agent.createRequestIdentity();
		const firstCompaction = manager.appendCompaction("summary one", firstMessageId, 100);
		await (
			await session.agent.streamFunction(harness.getModel(), { messages: [] }, { requestIdentity: retryIdentity })
		).result();
		const secondCompaction = manager.appendCompaction("summary two", firstMessageId, 100);
		await (
			await session.agent.streamFunction(harness.getModel(), { messages: [] }, { requestIdentity: retryIdentity })
		).result();
		expect(identities.slice(1, 3).map((identity) => identity.turnId)).toEqual([
			retryIdentity.turnId,
			retryIdentity.turnId,
		]);
		expect(identities.slice(1, 3).map((identity) => identity.startedAt)).toEqual([
			retryIdentity.startedAt,
			retryIdentity.startedAt,
		]);
		expect(retryIdentity.windowId).toBe(`${manager.getSessionId()}:0`);

		const resumedManager = SessionManager.open(manager.getSessionFile()!);
		const resumed = await openSession(resumedManager);
		await resumed.prompt("resume");
		for (const leaf of [rootLeaf, firstCompaction, secondCompaction]) {
			resumedManager.branch(leaf);
			resumed.agent.state.messages = resumedManager.buildSessionContext().messages;
			await resumed.prompt("branch");
		}
		expect(identities.map((identity) => identity.windowId)).toEqual(
			[0, 1, 2, 2, 0, 1, 2].map((number) => `${manager.getSessionId()}:${number}`),
		);

		const forkPath = resumedManager.createBranchedSession(secondCompaction)!;
		const forkManager = SessionManager.open(forkPath);
		const fork = await openSession(forkManager);
		await fork.prompt("fork");
		expect(forkManager.getSessionId()).not.toBe(manager.getSessionId());
		expect(identities.at(-1)).toMatchObject({
			threadId: forkManager.getSessionId(),
			windowId: `${forkManager.getSessionId()}:2`,
		});
	});

	it.each(["success", "failure", "cancel"] as const)(
		"advances only after committed compaction: %s",
		async (outcome) => {
			await setup();
			const manager = harness.sessionManager;
			const session = await openSession(manager, outcome === "cancel");
			harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
			await session.prompt("first");
			await session.prompt("second");
			harness.setResponses(
				outcome === "failure"
					? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid summary request" })]
					: [fauxAssistantMessage("history summary"), fauxAssistantMessage("turn prefix summary")],
			);
			if (outcome === "success") await session.compact();
			else
				await expect(session.compact()).rejects.toThrow(
					outcome === "cancel" ? "Compaction cancelled" : "invalid summary request",
				);
			const summaryIdentities = identities.filter((identity) => identity.requestKind === "compaction");
			expect(summaryIdentities).toHaveLength(outcome === "success" ? 2 : outcome === "failure" ? 1 : 0);
			for (const identity of identities) expect(identity.windowId).toBe(`${manager.getSessionId()}:0`);
			if (outcome === "success") expect(summaryIdentities[0].turnId).toBe(summaryIdentities[1].turnId);
			expect(manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(
				outcome === "success" ? 1 : 0,
			);
			harness.setResponses([fauxAssistantMessage("after")]);
			await session.prompt("after compaction attempt");
			expect(identities.at(-1)?.windowId).toBe(`${manager.getSessionId()}:${outcome === "success" ? 1 : 0}`);
		},
	);

	it("advances the window but preserves the active turn during overflow recovery", async () => {
		await setup();
		const manager = harness.sessionManager;
		const session = await openSession(manager);
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		await session.prompt("first");
		await session.prompt("second");
		harness.settingsManager.applyOverrides({ compaction: { enabled: true } });
		identities.length = 0;
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			fauxAssistantMessage("history summary"),
			fauxAssistantMessage("turn prefix summary"),
			fauxAssistantMessage("recovered"),
		]);
		await session.prompt("trigger overflow");
		expect(manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		const foreground = identities.filter((identity) => identity.requestKind === "turn");
		expect(foreground).toHaveLength(2);
		expect(foreground[1]).toEqual({ ...foreground[0], windowId: `${manager.getSessionId()}:1` });
		expect(foreground[0].windowId).toBe(`${manager.getSessionId()}:0`);
		for (const identity of identities.filter((candidate) => candidate.requestKind === "compaction")) {
			expect(identity.windowId).toBe(`${manager.getSessionId()}:0`);
		}
	});
});
