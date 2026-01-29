import { describe, expect, test } from "vitest";
import {
	buildSubscribeSelectItems,
	buildUnsubscribeSelectItems,
	filterRecentSubscriptionSessions,
} from "../src/subscriptions/subscription-selection.js";

describe("filterRecentSubscriptionSessions", () => {
	test("filters out current, subscribed, invalid, and old sessions", () => {
		const now = new Date("2026-01-29T00:00:00.000Z");
		const currentSessionId = "11111111-1111-1111-1111-111111111111";
		const subscribedSessionId = "22222222-2222-2222-2222-222222222222";
		const validRecentSessionId = "33333333-3333-3333-3333-333333333333";
		const oldSessionId = "44444444-4444-4444-4444-444444444444";

		const sessions = [
			{
				id: currentSessionId,
				modified: new Date("2026-01-28T23:30:00.000Z"),
				firstMessage: "Current session",
				messageCount: 3,
			},
			{
				id: subscribedSessionId,
				modified: new Date("2026-01-28T23:20:00.000Z"),
				firstMessage: "Subscribed session",
				messageCount: 2,
			},
			{
				id: "not-a-uuid",
				modified: new Date("2026-01-28T23:10:00.000Z"),
				firstMessage: "Invalid session",
				messageCount: 1,
			},
			{
				id: oldSessionId,
				modified: new Date("2026-01-27T23:00:00.000Z"),
				firstMessage: "Old session",
				messageCount: 4,
			},
			{
				id: validRecentSessionId,
				modified: new Date("2026-01-28T23:50:00.000Z"),
				firstMessage: "Recent session",
				messageCount: 5,
			},
		];

		const result = filterRecentSubscriptionSessions(sessions, {
			now,
			maxAgeMs: 24 * 60 * 60 * 1000,
			currentSessionId,
			subscribedSessionIds: new Set([subscribedSessionId]),
		});

		expect(result.map((session) => session.id)).toEqual([validRecentSessionId]);
	});

	test("preserves input order for remaining sessions", () => {
		const now = new Date("2026-01-29T00:00:00.000Z");
		const sessionA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
		const sessionB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

		const sessions = [
			{
				id: sessionA,
				modified: new Date("2026-01-28T23:40:00.000Z"),
				firstMessage: "First",
				messageCount: 1,
			},
			{
				id: sessionB,
				modified: new Date("2026-01-28T23:50:00.000Z"),
				firstMessage: "Second",
				messageCount: 2,
			},
		];

		const result = filterRecentSubscriptionSessions(sessions, {
			now,
			maxAgeMs: 24 * 60 * 60 * 1000,
			currentSessionId: "",
			subscribedSessionIds: new Set(),
		});

		expect(result.map((session) => session.id)).toEqual([sessionA, sessionB]);
	});
});

describe("buildSubscribeSelectItems", () => {
	test("prefers title when available", () => {
		const sessions = [
			{
				id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
				modified: new Date("2026-01-28T23:40:00.000Z"),
				firstMessage: "Hello there",
				messageCount: 2,
				title: "Planning work",
			},
		];

		const items = buildSubscribeSelectItems(sessions);

		expect(items).toEqual([
			{
				id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
				label: "Planning work",
				description: "2 messages",
			},
		]);
	});

	test("strips timestamp tag from first message", () => {
		const sessions = [
			{
				id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
				modified: new Date("2026-01-28T23:45:00.000Z"),
				firstMessage:
					"<user_message_time>Thursday, January 29, 2026 at 10:12 AM GMT+8</user_message_time>\n\nHello there",
				messageCount: 1,
			},
		];

		const items = buildSubscribeSelectItems(sessions);

		expect(items).toEqual([
			{
				id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
				label: "Hello there",
				description: "1 message",
			},
		]);
	});
});

describe("buildUnsubscribeSelectItems", () => {
	test("falls back to id and default description when summary is missing", () => {
		const sessionId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
		const items = buildUnsubscribeSelectItems([sessionId], new Map());

		expect(items).toEqual([
			{
				id: sessionId,
				label: sessionId,
				description: "Subscribed session",
			},
		]);
	});

	test("uses summary label and message count when available", () => {
		const sessionId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
		const summaries = new Map([
			[
				sessionId,
				{
					id: sessionId,
					modified: new Date("2026-01-28T23:40:00.000Z"),
					firstMessage:
						"<user_message_time>Thursday, January 29, 2026 at 10:12 AM GMT+8</user_message_time>\n\nSubscription summary",
					messageCount: 1,
					title: "Support work",
				},
			],
		]);

		const items = buildUnsubscribeSelectItems([sessionId], summaries);

		expect(items).toEqual([
			{
				id: sessionId,
				label: "Support work",
				description: "1 message",
			},
		]);
	});
});
