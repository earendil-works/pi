import type { SessionSnapshot } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	applyTranscriptProgress,
	applyTranscriptSnapshot,
	createTranscriptState,
	selectTranscript,
} from "../../src/client/transcript.ts";

function snapshot(revision: number, text = "saved"): SessionSnapshot {
	return {
		id: "session-1",
		cwd: "/workspace",
		createdAt: 1,
		updatedAt: revision + 1,
		phase: "turn",
		model: { provider: "faux", id: "faux-1" },
		thinkingLevel: "off",
		attached: true,
		locked: true,
		revision,
		transcript: [
			{
				id: "assistant-1",
				role: "assistant",
				content: [{ type: "text", text }],
				status: "streaming",
				model: { provider: "faux", id: "faux-1" },
				timestamp: 1,
			},
		],
		queuedSteer: [],
		queuedSteerCount: 0,
	};
}

describe("remote transcript projection", () => {
	test("projects progress without mutating the authoritative snapshot", () => {
		let state = createTranscriptState(snapshot(1));
		state = applyTranscriptProgress(state, {
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "text",
			delta: " response",
		});

		expect(state.snapshot.transcript[0]).toMatchObject({ content: [{ type: "text", text: "saved" }] });
		expect(selectTranscript(state)[0]).toMatchObject({ content: [{ type: "text", text: "saved response" }] });
	});

	test("applies streamed tool-call argument deltas", () => {
		let state = createTranscriptState({
			...snapshot(1),
			transcript: [
				{
					id: "assistant-1",
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: null }],
					status: "streaming",
					model: { provider: "faux", id: "faux-1" },
					timestamp: 1,
				},
			],
		});
		state = applyTranscriptProgress(state, {
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "toolCall",
			delta: '{"command":',
		});
		expect(selectTranscript(state)[0]).toMatchObject({ content: [{ input: '{"command":' }] });

		state = applyTranscriptProgress(state, {
			type: "item_updated",
			item: {
				id: "assistant-1",
				role: "assistant",
				content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: null }],
				status: "streaming",
				model: { provider: "faux", id: "faux-1" },
				timestamp: 1,
			},
		});
		state = applyTranscriptProgress(state, {
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "toolCall",
			delta: '"pwd"}',
		});
		expect(selectTranscript(state)[0]).toMatchObject({ content: [{ input: { command: "pwd" } }] });
	});

	test("appends tool-call deltas to a partial input restored from a snapshot", () => {
		let state = createTranscriptState({
			...snapshot(1),
			transcript: [
				{
					id: "assistant-1",
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: '{"command":' }],
					status: "streaming",
					model: { provider: "faux", id: "faux-1" },
					timestamp: 1,
				},
			],
		});

		state = applyTranscriptProgress(state, {
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "toolCall",
			delta: '"pwd"}',
		});

		expect(selectTranscript(state)[0]).toMatchObject({ content: [{ input: { command: "pwd" } }] });
	});

	test("appends transient tool progress and replaces it by id", () => {
		let state = createTranscriptState(snapshot(1));
		state = applyTranscriptProgress(state, {
			type: "item_started",
			item: {
				id: "tool-call-1",
				role: "tool",
				toolCallId: "call-1",
				toolName: "bash",
				input: { command: "printf hi" },
				content: [],
				status: "running",
				isError: false,
				timestamp: 2,
			},
		});
		expect(selectTranscript(state).at(-1)).toMatchObject({
			id: "tool-call-1",
			role: "tool",
			status: "running",
			content: [],
		});
		state = applyTranscriptProgress(state, {
			type: "item_updated",
			item: {
				id: "tool-call-1",
				role: "tool",
				toolCallId: "call-1",
				toolName: "bash",
				input: { command: "printf hi" },
				content: [{ type: "text", text: "hi" }],
				status: "running",
				isError: false,
				timestamp: 2,
			},
		});

		expect(selectTranscript(state)).toHaveLength(2);
		expect(selectTranscript(state)[1]).toMatchObject({
			role: "tool",
			status: "running",
			content: [{ type: "text", text: "hi" }],
		});
	});

	test("resets revision history when the same session runtime is reacquired", () => {
		let state = createTranscriptState(snapshot(50, "old runtime"));
		state = createTranscriptState(snapshot(0, "new runtime"));

		expect(state.snapshot.revision).toBe(0);
		expect(selectTranscript(state)[0]).toMatchObject({ content: [{ text: "new runtime" }] });
	});

	test("accepts a lower revision when switching to a different session", () => {
		let state = createTranscriptState(snapshot(50, "old session"));
		state = applyTranscriptSnapshot(state, { ...snapshot(0, "new session"), id: "session-2" });

		expect(state.snapshot.id).toBe("session-2");
		expect(selectTranscript(state)[0]).toMatchObject({ content: [{ text: "new session" }] });
	});

	test("renders accepted steering messages from authoritative queued state", () => {
		const state = createTranscriptState({
			...snapshot(2),
			queuedSteerCount: 1,
			queuedSteer: [
				{
					id: "user-steer",
					role: "user",
					content: [{ type: "text", text: "adjust the approach" }],
					timestamp: 2,
				},
			],
		});

		expect(selectTranscript(state).at(-1)).toMatchObject({
			role: "user",
			content: [{ text: "adjust the approach" }],
		});
	});

	test("a newer snapshot is authoritative and stale snapshots are ignored", () => {
		let state = createTranscriptState(snapshot(3, "new"));
		state = applyTranscriptProgress(state, {
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "text",
			delta: " transient",
		});
		state = applyTranscriptSnapshot(state, snapshot(4, "authoritative"));
		state = applyTranscriptSnapshot(state, snapshot(2, "stale"));

		expect(state.snapshot.revision).toBe(4);
		expect(selectTranscript(state)[0]).toMatchObject({
			content: [{ type: "text", text: "authoritative" }],
		});
	});
});
