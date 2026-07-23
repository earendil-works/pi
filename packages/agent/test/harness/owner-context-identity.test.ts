import {
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { type ContextEntryTransform, Session } from "../../src/harness/session/session.ts";
import type { SessionMetadata, SessionTreeEntry } from "../../src/harness/types.ts";
import type { AgentMessage } from "../../src/types.ts";
import { calculateTool } from "../utils/calculate.ts";

interface OwnerIdentity {
	entryId: string;
	sessionId: string;
}

interface ProjectedOwnerIdentity extends OwnerIdentity {
	messageIndex: number;
}

const models = createModels();
let fauxCount = 0;

function newFaux(): FauxProviderHandle {
	const faux = fauxProvider({ provider: `owner-context-faux-${++fauxCount}` });
	models.setProvider(faux.provider);
	return faux;
}

class CorruptBranchStorage extends InMemorySessionStorage {
	private readonly corruption: "missing" | "duplicate";

	constructor(corruption: "missing" | "duplicate") {
		super();
		this.corruption = corruption;
	}

	override async getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]> {
		const branch = await super.getPathToRootOrCompaction(leafId);
		const owner = [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "user");
		if (!owner) return branch;
		return this.corruption === "missing" ? branch.filter((entry) => entry !== owner) : [...branch, owner];
	}
}

class GenerationMismatchStorage extends InMemorySessionStorage {
	private metadataReads = 0;

	override async getMetadata(): Promise<SessionMetadata> {
		this.metadataReads += 1;
		return {
			id: this.metadataReads === 1 ? "generation-a" : "generation-b",
			createdAt: "2026-07-23T00:00:00.000Z",
		};
	}
}

describe("AgentHarness committed owner identity", () => {
	it("distinguishes byte-identical owners by their atomically committed session entry IDs", async () => {
		const registration = newFaux();
		registration.setResponses([() => fauxAssistantMessage("first"), () => fauxAssistantMessage("second")]);
		const session = new Session(new InMemorySessionStorage());
		const sessionId = (await session.getMetadata()).id;
		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
		});
		const contextOwners: ProjectedOwnerIdentity[] = [];
		const settledOwners: OwnerIdentity[] = [];
		harness.on("context", (event) => {
			contextOwners.push(event.owner);
			return undefined;
		});
		harness.subscribe((event) => {
			if (event.type === "settled") settledOwners.push(event.owner);
		});

		await harness.prompt("same bytes");
		await harness.prompt("same bytes");

		expect(contextOwners).toHaveLength(2);
		expect(contextOwners[0]?.entryId).not.toBe(contextOwners[1]?.entryId);
		expect(contextOwners.map((owner) => owner.sessionId)).toEqual([sessionId, sessionId]);
		expect(contextOwners.map((owner) => owner.messageIndex)).toEqual([0, 2]);
		expect(settledOwners).toEqual(
			contextOwners.map(({ entryId, sessionId: ownerSessionId }) => ({
				entryId,
				sessionId: ownerSessionId,
			})),
		);

		const entries = await session.getEntries();
		for (const owner of contextOwners) {
			const matches = entries.filter((entry) => entry.id === owner.entryId);
			expect(matches).toHaveLength(1);
			expect(matches[0]).toMatchObject({
				type: "message",
				message: { role: "user" },
			});
		}
	});

	it("preserves one committed owner identity across same-turn tool reprojections", async () => {
		const registration = newFaux();
		registration.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
			() => fauxAssistantMessage("done"),
		]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
			tools: [calculateTool],
		});
		const contextOwners: ProjectedOwnerIdentity[] = [];
		let settledOwner: OwnerIdentity | undefined;
		harness.on("context", (event) => {
			contextOwners.push(event.owner);
			return undefined;
		});
		harness.subscribe((event) => {
			if (event.type === "settled") settledOwner = event.owner;
		});

		await harness.prompt("calculate");

		expect(contextOwners).toHaveLength(2);
		expect(contextOwners[0]).toEqual({
			entryId: expect.any(String),
			sessionId: expect.any(String),
			messageIndex: 0,
		});
		expect(contextOwners[1]).toEqual({
			...contextOwners[0],
			messageIndex: 0,
		});
		expect(settledOwner).toEqual({
			entryId: contextOwners[0]?.entryId,
			sessionId: contextOwners[0]?.sessionId,
		});
	});

	it("binds the exact host owner and projects its index ahead of an identical injected user", async () => {
		const registration = newFaux();
		registration.setResponses([() => fauxAssistantMessage("done")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
		});
		let contextOwner: ProjectedOwnerIdentity | undefined;
		let contextMessages: AgentMessage[] | undefined;
		harness.on("before_agent_start", () => ({
			messages: [{ role: "user", content: [{ type: "text", text: "same bytes" }], timestamp: 1 }],
		}));
		harness.on("context", (event) => {
			contextOwner = event.owner;
			contextMessages = event.messages;
			return undefined;
		});

		await harness.prompt("same bytes");

		const userEntries = (await session.getEntries()).filter(
			(entry): entry is Extract<SessionTreeEntry, { type: "message" }> =>
				entry.type === "message" && entry.message.role === "user",
		);
		expect(userEntries).toHaveLength(2);
		expect(contextOwner).toEqual({
			entryId: userEntries[0]?.id,
			sessionId: expect.any(String),
			messageIndex: 0,
		});
		expect(contextMessages).toHaveLength(2);
		expect(contextMessages?.[contextOwner!.messageIndex]).toMatchObject({ role: "user" });
	});

	it("binds the exact host owner after an identical queued user", async () => {
		const registration = newFaux();
		registration.setResponses([() => fauxAssistantMessage("done")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
		});
		let contextOwner: ProjectedOwnerIdentity | undefined;
		await harness.nextTurn("same bytes");
		harness.on("context", (event) => {
			contextOwner = event.owner;
			return undefined;
		});

		await harness.prompt("same bytes");

		const userEntries = (await session.getEntries()).filter(
			(entry): entry is Extract<SessionTreeEntry, { type: "message" }> =>
				entry.type === "message" && entry.message.role === "user",
		);
		expect(userEntries).toHaveLength(2);
		expect(contextOwner).toEqual({
			entryId: userEntries[1]?.id,
			sessionId: expect.any(String),
			messageIndex: 1,
		});
	});

	it.each([
		[
			"filtered",
			((entries) => {
				const latestUser = [...entries]
					.reverse()
					.find((entry) => entry.type === "message" && entry.message.role === "user");
				return latestUser ? entries.filter((entry) => entry !== latestUser) : entries;
			}) satisfies ContextEntryTransform,
			false,
		],
		["reordered", ((entries) => [...entries].reverse()) satisfies ContextEntryTransform, true],
	] as const)("fails closed before provider dispatch when owner provenance is %s", async (_label, transform, seed) => {
		const registration = newFaux();
		let providerCalls = 0;
		registration.setResponses([
			() => {
				providerCalls += 1;
				return fauxAssistantMessage("must not dispatch");
			},
		]);
		const session = new Session(new InMemorySessionStorage(), { entryTransforms: [transform] });
		if (seed) {
			await session.appendMessage({
				role: "user",
				content: [{ type: "text", text: "prior" }],
				timestamp: 1,
			});
			await session.appendMessage(fauxAssistantMessage("prior response"));
		}
		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
		});

		const result = await harness.prompt("owner");

		expect(providerCalls).toBe(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/committed owner.*provenance/i);
	});

	it.each(["missing", "duplicate"] as const)(
		"fails closed before provider dispatch when the committed owner is %s in the public branch projection",
		async (corruption) => {
			const registration = newFaux();
			let providerCalls = 0;
			registration.setResponses([
				() => {
					providerCalls += 1;
					return fauxAssistantMessage("must not dispatch");
				},
			]);
			const harness = new AgentHarness({
				models,
				session: new Session(new CorruptBranchStorage(corruption)),
				model: registration.getModel(),
			});

			const result = await harness.prompt("owner");

			expect(providerCalls).toBe(0);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/committed owner/i);
		},
	);

	it("fails closed before provider dispatch when the session generation changes", async () => {
		const registration = newFaux();
		let providerCalls = 0;
		registration.setResponses([
			() => {
				providerCalls += 1;
				return fauxAssistantMessage("must not dispatch");
			},
		]);
		const harness = new AgentHarness({
			models,
			session: new Session(new GenerationMismatchStorage()),
			model: registration.getModel(),
		});

		const result = await harness.prompt("owner");

		expect(providerCalls).toBe(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/session.*identity|generation/i);
	});
});
