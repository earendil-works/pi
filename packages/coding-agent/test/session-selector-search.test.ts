import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { filterAndSortSessions } from "../src/modes/interactive/components/session-selector-search.ts";

function makeSession(
	overrides: Partial<SessionInfo> & { id: string; modified: Date; allMessagesText: string },
): SessionInfo {
	return {
		path: `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified,
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "(no messages)",
		allMessagesText: overrides.allMessagesText,
	};
}

describe("session selector search", () => {
	it("filters by quoted phrase with whitespace normalization", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "a",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "node\n\n   cve was discussed",
			}),
			makeSession({
				id: "b",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				allMessagesText: "node something else",
			}),
		];

		const result = filterAndSortSessions(sessions, '"node cve"', "recent");
		expect(result.map((s) => s.id)).toEqual(["a"]);
	});

	it("filters by regex (re:) and is case-insensitive", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "a",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				allMessagesText: "Brave is great",
			}),
			makeSession({
				id: "b",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				allMessagesText: "bravery is not the same",
			}),
		];

		const result = filterAndSortSessions(sessions, "re:\\bbrave\\b", "recent");
		expect(result.map((s) => s.id)).toEqual(["a"]);
	});

	it("recent sort preserves input order", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "newer",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				allMessagesText: "brave",
			}),
			makeSession({
				id: "older",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "brave",
			}),
			makeSession({
				id: "nomatch",
				modified: new Date("2026-01-04T00:00:00.000Z"),
				allMessagesText: "something else",
			}),
		];

		const result = filterAndSortSessions(sessions, '"brave"', "recent");
		expect(result.map((s) => s.id)).toEqual(["newer", "older"]);
	});

	it("relevance sort orders by score and tie-breaks by modified desc", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "message",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				allMessagesText: "brave",
			}),
			makeSession({
				id: "name",
				name: "Brave work",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "xxxx",
			}),
		];

		const result1 = filterAndSortSessions(sessions, '"brave"', "relevance");
		expect(result1.map((s) => s.id)).toEqual(["name", "message"]);

		const tieSessions: SessionInfo[] = [
			makeSession({
				id: "newer",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				allMessagesText: "brave",
			}),
			makeSession({
				id: "older",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "brave",
			}),
		];

		const result2 = filterAndSortSessions(tieSessions, '"brave"', "relevance");
		expect(result2.map((s) => s.id)).toEqual(["newer", "older"]);
	});

	// #11220
	it("ignores the position of a match in message text", () => {
		const filler = "lorem ipsum dolor sit amet ".repeat(400);
		const sessions: SessionInfo[] = [
			makeSession({
				id: "early",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: `opus ${filler}`,
			}),
			makeSession({
				id: "deep",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				allMessagesText: `${filler} we discussed the opus model`,
			}),
			makeSession({
				id: "scattered",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				allMessagesText: filler,
			}),
		];

		const result = filterAndSortSessions(sessions, "opus", "relevance");
		expect(result.map((s) => s.id)).toEqual(["deep", "early"]);
	});

	// #11024
	it("does not match scattered characters in session ids", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "019e9024-aaaa-7bbb-8ccc-dddddddddddd",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				allMessagesText: "unrelated",
			}),
			makeSession({
				id: "01a1ffff-aaaa-7bbb-8ccc-dddddddddddd",
				name: "#1024 TDD bare env",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "unrelated",
			}),
		];

		expect(filterAndSortSessions(sessions, "1024", "relevance").map((s) => s.name)).toEqual(["#1024 TDD bare env"]);
		expect(filterAndSortSessions(sessions, "9024-aa", "relevance").map((s) => s.id)).toEqual([
			"019e9024-aaaa-7bbb-8ccc-dddddddddddd",
		]);
	});

	it("ranks name text, then message text, then scattered name matches", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "scattered-name",
				name: "c-a-c-h-e notes",
				modified: new Date("2026-01-04T00:00:00.000Z"),
				allMessagesText: "unrelated",
			}),
			makeSession({
				id: "message",
				name: "Other work",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				allMessagesText: "A discussion mentioning the cache.",
			}),
			makeSession({
				id: "name",
				name: "Cache work",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "Summary",
			}),
		];

		expect(filterAndSortSessions(sessions, "cache", "relevance").map((s) => s.id)).toEqual([
			"name",
			"message",
			"scattered-name",
		]);
	});

	it("matches each token within a single field", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "split",
				name: "Fuzzy",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "search ranking",
			}),
		];

		expect(filterAndSortSessions(sessions, "fuzzy ranking", "relevance").map((s) => s.id)).toEqual(["split"]);
		expect(filterAndSortSessions(sessions, "zzysea", "relevance")).toEqual([]);
		expect(filterAndSortSessions(sessions, "re:fuzzy search", "relevance")).toEqual([]);
	});

	it("ranks regex name matches first", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "message",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				allMessagesText: "brave",
			}),
			makeSession({
				id: "name",
				name: "Brave",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "xxxx",
			}),
		];

		expect(filterAndSortSessions(sessions, "re:\\bbrave\\b", "relevance").map((s) => s.id)).toEqual([
			"name",
			"message",
		]);
	});

	it("returns empty list for invalid regex", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "a",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "brave",
			}),
		];

		const result = filterAndSortSessions(sessions, "re:(", "recent");
		expect(result).toEqual([]);
	});

	describe("name filter", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "named1",
				name: "My Project",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				allMessagesText: "blueberry",
			}),
			makeSession({
				id: "named2",
				name: "Another Named",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				allMessagesText: "blueberry",
			}),
			makeSession({
				id: "other1",
				modified: new Date("2026-01-04T00:00:00.000Z"),
				allMessagesText: "blueberry",
			}),
			makeSession({
				id: "other2",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "blueberry",
			}),
		];

		it("returns all sessions when nameFilter is 'all'", () => {
			const result = filterAndSortSessions(sessions, "", "recent", "all");
			expect(result.map((session) => session.id)).toEqual(["named1", "named2", "other1", "other2"]);
		});

		it("returns only named sessions when nameFilter is 'named'", () => {
			const result = filterAndSortSessions(sessions, "", "recent", "named");
			expect(result.map((session) => session.id)).toEqual(["named1", "named2"]);
		});

		it("applies name filter before search query", () => {
			const result = filterAndSortSessions(sessions, "blueberry", "recent", "named");
			expect(result.map((session) => session.id)).toEqual(["named1", "named2"]);
		});

		it("excludes whitespace-only names from named filter", () => {
			const sessionsWithWhitespace: SessionInfo[] = [
				makeSession({
					id: "whitespace",
					name: "   ",
					modified: new Date("2026-01-01T00:00:00.000Z"),
					allMessagesText: "test",
				}),
				makeSession({
					id: "empty",
					name: "",
					modified: new Date("2026-01-02T00:00:00.000Z"),
					allMessagesText: "test",
				}),
				makeSession({
					id: "named",
					name: "Real Name",
					modified: new Date("2026-01-03T00:00:00.000Z"),
					allMessagesText: "test",
				}),
			];

			const result = filterAndSortSessions(sessionsWithWhitespace, "", "recent", "named");
			expect(result.map((session) => session.id)).toEqual(["named"]);
		});
	});
});
