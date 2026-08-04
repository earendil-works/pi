import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	Session as CoreSession,
	Entry,
	MessageEntry,
	ModelChangeEntry,
	ThinkingLevelChangeEntry,
} from "@earendil-works/pi-agent-core/experimental";
import type { Usage } from "@earendil-works/pi-ai";
import { afterEach } from "vitest";
import type { SqliteSessionMetadata } from "../../../storage/sqlite-node/src/index.ts";
import { InMemorySessionRepository } from "../../src/harness/session/memory-repo.ts";
import type { Session } from "../../src/harness/session/session.ts";

export async function createInMemorySession(id?: string): Promise<Session> {
	return new InMemorySessionRepository().create({ id });
}

export function createUserMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

export function createAssistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export type SqliteTestSession = CoreSession<SqliteSessionMetadata>;
export type SqliteTestMessage = MessageEntry["message"];

export async function appendSqliteCompaction(
	session: SqliteTestSession,
	summary: string,
	_firstKeptEntryId: string | undefined,
	tokensBefore: number,
	details?: unknown,
	_fromHook?: boolean,
	usage?: Usage,
	retainedTail: SqliteTestMessage[] = [],
): Promise<string> {
	const provisioned = {
		type: "compaction",
		id: session.idGenerator.next(),
		summary,
		retainedTail,
		tokensBefore,
		...(details === undefined ? {} : { details }),
		...(usage === undefined ? {} : { usage }),
	} satisfies Omit<CompactionEntry, "parentId" | "seq" | "timestamp">;
	const entry = await session.appendEntry(provisioned, "main");
	return entry.id;
}

export async function moveSqliteMainLane(
	session: SqliteTestSession,
	entryId: string | null,
	summary?: { summary: string; details?: unknown; usage?: Usage; fromHook?: boolean },
): Promise<string | undefined> {
	await session.moveLane("main", entryId);
	if (!summary) return undefined;
	const provisioned = {
		type: "branch_summary",
		id: session.idGenerator.next(),
		fromId: entryId ?? "root",
		summary: summary.summary,
		...(summary.details === undefined ? {} : { details: summary.details }),
		...(summary.usage === undefined ? {} : { usage: summary.usage }),
	} satisfies Omit<BranchSummaryEntry, "parentId" | "seq" | "timestamp">;
	const entry = await session.appendEntry(provisioned, "main");
	return entry.id;
}

export async function getSqliteBranch(session: SqliteTestSession, fromId?: string | null): Promise<Entry[]> {
	const start = fromId === undefined ? await session.getLeafId() : fromId;
	if (start === null) return [];
	const newestWindow = await session.findEntriesOnBranch({ start, stopAtType: "compaction" });
	return newestWindow.reverse();
}

export async function getSqliteEntries(
	session: SqliteTestSession,
	options?: { afterEntrySeq?: number; limit?: number },
): Promise<Entry[]> {
	return session.findEntries({
		order: "oldestFirst",
		limit: options?.limit,
		cursor: options?.afterEntrySeq === undefined ? undefined : { afterSeq: options.afterEntrySeq },
	});
}

export async function appendSqliteSessionName(session: SqliteTestSession, name: string): Promise<void> {
	await session.setName(name.replace(/[\r\n]+/g, " ").trim());
}

export async function appendSqliteLabel(
	session: SqliteTestSession,
	targetId: string,
	label: string | undefined,
): Promise<void> {
	await session.setLabel(targetId, label);
}

export async function buildSqliteContext(session: SqliteTestSession): Promise<{ messages: SqliteTestMessage[] }> {
	const entries = await getSqliteBranch(session);
	const messages = entries.flatMap((entry): SqliteTestMessage[] => {
		if (entry.type === "message") return [entry.message];
		if (entry.type === "compaction") return entry.retainedTail;
		return [];
	});
	return { messages };
}

export async function appendSqliteThinkingLevelChange(
	session: SqliteTestSession,
	thinkingLevel: string,
): Promise<string> {
	const entry = await session.appendEntry(
		{
			type: "thinking_level_change",
			id: session.idGenerator.next(),
			thinkingLevel,
		} satisfies Omit<ThinkingLevelChangeEntry, "parentId" | "seq" | "timestamp">,
		"main",
	);
	return entry.id;
}

export async function appendSqliteModelChange(
	session: SqliteTestSession,
	provider: string,
	modelId: string,
): Promise<string> {
	const entry = await session.appendEntry(
		{
			type: "model_change",
			id: session.idGenerator.next(),
			provider,
			modelId,
		} satisfies Omit<ModelChangeEntry, "parentId" | "seq" | "timestamp">,
		"main",
	);
	return entry.id;
}

const tempDirs: string[] = [];

export function createTempDir(): string {
	const dir = join(tmpdir(), `pi-agent-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});
