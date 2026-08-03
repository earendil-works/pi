import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionBackend } from "../../src/harness/session/jsonl-repo.ts";
import { InMemorySessionBackend } from "../../src/harness/session/memory-repo.ts";
import {
	type ContextEntryTransform,
	createSession,
	type Session,
	type SessionContextBuildOptions,
} from "../../src/harness/session/session.ts";
import { createAssistantMessage, createTempDir, createUserMessage } from "./session-test-utils.ts";

function getTextData(data: unknown): string {
	if (typeof data !== "object" || data === null || !("text" in data)) {
		return "";
	}
	const value = (data as { text?: unknown }).text;
	return typeof value === "string" ? value : "";
}

interface SessionFixture {
	createSession(options?: SessionContextBuildOptions): Promise<Session>;
	reloadSession(options?: SessionContextBuildOptions): Promise<Session>;
}

async function runSessionSuite(name: string, createFixture: () => Promise<SessionFixture>, inspect?: () => void) {
	describe(name, () => {
		it("appends messages and builds context in order", async () => {
			const session = await (await createFixture()).createSession();
			await session.appendMessage(createUserMessage("one"));
			await session.appendMessage(createAssistantMessage("two"));
			const context = await session.buildContext();
			expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		});

		it("reads entries forward from the requested sequence", async () => {
			const session = await (await createFixture()).createSession();
			const ids = [
				await session.appendMessage(createUserMessage("one")),
				await session.appendMessage(createUserMessage("two")),
				await session.appendMessage(createUserMessage("three")),
			];

			expect((await session.getEntries({ afterEntrySeq: 0, limit: 2 })).map((entry) => entry.id)).toEqual(
				ids.slice(0, 2),
			);
			expect((await session.getEntries({ afterEntrySeq: 1, limit: 2 })).map((entry) => entry.id)).toEqual(
				ids.slice(1),
			);
			expect((await session.getEntries({ afterEntrySeq: 2 })).map((entry) => entry.id)).toEqual(ids.slice(2));
		});

		it("tracks model and thinking level changes", async () => {
			const session = await (await createFixture()).createSession();
			await session.appendMessage(createUserMessage("one"));
			await session.appendModelChange("openai", "gpt-4.1");
			await session.appendThinkingLevelChange("high");
			const context = await session.buildContext();
			expect(context.thinkingLevel).toBe("high");
			expect(context.model).toEqual({ provider: "openai", modelId: "gpt-4.1" });
		});

		it("supports branching by moving the leaf and appending a new branch", async () => {
			const session = await (await createFixture()).createSession();
			const user1 = await session.appendMessage(createUserMessage("one"));
			const assistant1 = await session.appendMessage(createAssistantMessage("two"));
			await session.appendMessage(createUserMessage("three"));
			await session.moveTo(user1);
			const branched = await session.appendMessage(createAssistantMessage("branched"));
			const branch = await session.getBranch();
			expect(branch.map((entry) => entry.id)).toEqual([user1, branched]);
			expect(branch.map((entry) => entry.id)).not.toContain(assistant1);
			const context = await session.buildContext();
			expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		});

		it("supports moving the leaf to root", async () => {
			const session = await (await createFixture()).createSession();
			await session.appendMessage(createUserMessage("one"));
			await session.moveTo(null);
			expect(await session.getLeafId()).toBeNull();
			expect((await session.buildContext()).messages).toEqual([]);
		});

		it("reconstructs compaction summaries in context", async () => {
			const session = await (await createFixture()).createSession();
			await session.appendMessage(createUserMessage("one"));
			await session.appendMessage(createAssistantMessage("two"));
			const user2 = await session.appendMessage(createUserMessage("three"));
			await session.appendMessage(createAssistantMessage("four"));
			await session.appendCompaction("summary", user2, 1234, undefined, undefined, undefined, [
				createUserMessage("three"),
				createAssistantMessage("four"),
			]);
			await session.appendMessage(createUserMessage("five"));
			const context = await session.buildContext();
			expect(context.messages[0]?.role).toBe("compactionSummary");
			expect(context.messages).toHaveLength(4);
			expect(context.messages.map((message) => message.role)).toEqual([
				"compactionSummary",
				"user",
				"assistant",
				"user",
			]);
		});

		it("supports moving with branch summary entries in context", async () => {
			const session = await (await createFixture()).createSession();
			const user1 = await session.appendMessage(createUserMessage("one"));
			const summaryId = await session.moveTo(user1, { summary: "summary text" });
			expect(summaryId).toBeTruthy();
			const summaryEntry = await session.getEntry(summaryId!);
			expect(summaryEntry).toMatchObject({ type: "branch_summary", parentId: user1, fromId: user1 });
			const context = await session.buildContext();
			expect(context.messages[1]?.role).toBe("branchSummary");
		});

		it("persists compaction usage", async () => {
			const session = await (await createFixture()).createSession();
			const firstKeptEntryId = await session.appendMessage(createUserMessage("one"));
			const usage = {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				totalTokens: 10,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
			};

			const compactionId = await session.appendCompaction(
				"summary",
				firstKeptEntryId,
				1234,
				undefined,
				false,
				usage,
			);

			const compactionEntry = await session.getEntry(compactionId);
			expect(compactionEntry?.type === "compaction" ? compactionEntry.usage : undefined).toEqual(usage);
		});

		it("persists branch summary usage", async () => {
			const session = await (await createFixture()).createSession();
			const user1 = await session.appendMessage(createUserMessage("one"));
			const usage = {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				totalTokens: 10,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
			};

			const summaryId = await session.moveTo(user1, { summary: "summary text", usage });

			const summaryEntry = await session.getEntry(summaryId!);
			expect(summaryEntry?.type === "branch_summary" ? summaryEntry.usage : undefined).toEqual(usage);
		});

		it("supports custom message entries in context", async () => {
			const session = await (await createFixture()).createSession();
			await session.appendMessage(createUserMessage("one"));
			await session.appendCustomMessageEntry("custom", "hello", true, { ok: true });
			const context = await session.buildContext();
			expect(context.messages[1]?.role).toBe("custom");
		});

		it("keeps custom entries in context entries but omits them from messages by default", async () => {
			const session = await (await createFixture()).createSession();
			await session.appendMessage(createUserMessage("one"));
			await session.appendCustomEntry("chat_message", { text: "hello" });
			const contextEntries = await session.buildContextEntries();
			const context = await session.buildContext();
			expect(contextEntries.map((entry) => entry.type)).toEqual(["message", "custom"]);
			expect(context.messages).toHaveLength(1);
		});

		it("projects custom entries with configured custom-entry projectors", async () => {
			const session = await (await createFixture()).createSession({
				entryProjectors: {
					chat_message: (entry) => [createUserMessage(`chat: ${getTextData(entry.data)}`)],
				},
			});
			await session.appendMessage(createUserMessage("one"));
			await session.appendCustomEntry("chat_message", { text: "hello" });
			const context = await session.buildContext();
			expect(context.messages.map((message) => message.role)).toEqual(["user", "user"]);
			expect(context.messages[1]).toMatchObject({ content: [{ type: "text", text: "chat: hello" }] });
		});

		it("applies context entry transforms after default compaction selection", async () => {
			let observedFirstEntryType: string | undefined;
			const dropCompaction: ContextEntryTransform = (entries) => {
				observedFirstEntryType = entries[0]?.type;
				return entries.filter((entry) => entry.type !== "compaction");
			};
			const session = await (await createFixture()).createSession({ entryTransforms: [dropCompaction] });
			await session.appendMessage(createUserMessage("one"));
			const kept = await session.appendMessage(createUserMessage("two"));
			await session.appendCompaction("summary", kept, 1234);
			await session.appendMessage(createUserMessage("three"));
			const context = await session.buildContext();
			expect(observedFirstEntryType).toBe("compaction");
			expect(context.messages.map((message) => message.role)).toEqual(["user", "user"]);
		});

		it("normalizes session names", async () => {
			const session = await (await createFixture()).createSession();
			await session.appendSessionName(" hello\nworld\r\nagain ");
			expect(await session.getSessionName()).toBe("hello world again");
		});

		it("supports labels and session info entries without affecting context", async () => {
			const session = await (await createFixture()).createSession();
			const user1 = await session.appendMessage(createUserMessage("one"));
			await session.appendLabel(user1, "checkpoint");
			await session.appendSessionName("name");
			const entries = await session.getEntries();
			expect(entries.some((entry) => entry.type === "label")).toBe(true);
			expect(entries.some((entry) => entry.type === "session_info")).toBe(true);
			expect(await session.getLabel(user1)).toBe("checkpoint");
			expect(await session.getSessionName()).toBe("name");
			expect((await session.buildContext()).messages).toHaveLength(1);
		});

		it("rejects labels for missing entries", async () => {
			const session = await (await createFixture()).createSession();
			await expect(session.appendLabel("missing", "checkpoint")).rejects.toThrow("Entry missing not found");
		});

		it("persists leaf changes and appended entries through the backend", async () => {
			const fixture = await createFixture();
			const session = await fixture.createSession();
			const user1 = await session.appendMessage(createUserMessage("one"));
			await session.appendMessage(createAssistantMessage("two"));
			await session.appendLabel(user1, "checkpoint");
			await session.appendSessionName("name");
			await session.moveTo(user1);
			await session.appendMessage(createAssistantMessage("branched"));
			const session2 = await fixture.reloadSession();
			const context = await session2.buildContext();
			expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
			expect(await session2.getLabel(user1)).toBe("checkpoint");
			expect(await session2.getSessionName()).toBe("name");
			inspect?.();
		});
	});
}

runSessionSuite("Session with in-memory backend", async () => {
	const backend = new InMemorySessionBackend();
	const created = await createSession(await backend.create({}));
	const metadata = await created.getMetadata();
	return {
		createSession: async (contextBuildOptions) => createSession(await backend.open(metadata), contextBuildOptions),
		reloadSession: async (contextBuildOptions) => createSession(await backend.open(metadata), contextBuildOptions),
	};
});

let jsonlSessionPath = "";
runSessionSuite(
	"Session with JSONL backend",
	async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const backend = new JsonlSessionBackend({ fs: env, sessionsRoot: join(dir, "sessions") });
		const created = await createSession(await backend.create({ cwd: dir, id: "session-1" }));
		const metadata = await created.getMetadata();
		jsonlSessionPath = metadata.path;
		return {
			createSession: async (contextBuildOptions) => createSession(await backend.open(metadata), contextBuildOptions),
			reloadSession: async (contextBuildOptions) => createSession(await backend.open(metadata), contextBuildOptions),
		};
	},
	() => {
		const lines = readFileSync(jsonlSessionPath, "utf8").trim().split("\n");
		expect(lines.length).toBeGreaterThan(1);
		const header = JSON.parse(lines[0]!);
		expect(header.type).toBe("session");
		expect(header.version).toBe(3);
		const entries = lines.slice(1).map((line) => JSON.parse(line));
		expect(entries.some((entry) => entry.type === "leaf")).toBe(true);
		for (const entry of entries) {
			expect(entry.type).not.toBe("entry");
			expect(typeof entry.id).toBe("string");
		}
	},
);
