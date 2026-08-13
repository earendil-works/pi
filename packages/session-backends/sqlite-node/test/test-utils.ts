import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentMessage,
	BranchSummaryEntry,
	CompactionEntry,
	Session as CoreSession,
	Entry,
	MessageEntry,
} from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { afterEach, vi } from "vitest";
import type { SqliteDatabaseFactory, SqliteSessionMetadata } from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

export function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-backend-sqlite-node-"));
	tempDirs.push(dir);
	return dir;
}

export function createSetupFailureSqlite(): {
	sqlite: SqliteDatabaseFactory;
	counts: { closes: number };
} {
	const counts = { closes: 0 };
	return {
		counts,
		sqlite: {
			async open() {
				return {
					exec() {
						throw new Error("setup failed");
					},
					prepare() {
						throw new Error("unexpected prepare");
					},
					transaction<T>(_fn: () => T): T {
						throw new Error("unexpected transaction");
					},
					close() {
						counts.closes += 1;
					},
				};
			},
		},
	};
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
	tokensBefore: number,
	details?: unknown,
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
	summary?: { summary: string; details?: unknown; usage?: Usage },
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
