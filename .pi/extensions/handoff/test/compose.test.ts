import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildComposeUserMessage, composeNoteBody, splitKickoff } from "../compose.ts";

describe("splitKickoff", () => {
	it("splits the trailing KICKOFF line off the body", () => {
		const text = "## Context\nWe wired the reader.\n\nKICKOFF: Wire archive-on-delivery next.";
		expect(splitKickoff(text)).toEqual({
			body: "## Context\nWe wired the reader.",
			kickoff: "Wire archive-on-delivery next.",
		});
	});

	it("tolerates trailing blank lines and a stray rule after the marker", () => {
		const text = "## Context\nBody.\n\nKICKOFF: Do the thing.\n\n---\n\n";
		expect(splitKickoff(text).kickoff).toBe("Do the thing.");
	});

	it("returns the whole text when the model omitted the marker", () => {
		const text = "## Context\nBody.\n\n## Next steps\nDo the thing.";
		expect(splitKickoff(text)).toEqual({ body: text });
	});

	it("does not treat a KICKOFF mention in the middle of the note as the marker", () => {
		const text = "## Context\nKICKOFF: this is quoted mid-note.\n\n## Next steps\nCarry on.";
		expect(splitKickoff(text)).toEqual({ body: text });
	});

	it("ignores a marker with no content after it", () => {
		expect(splitKickoff("## Context\nBody.\n\nKICKOFF:").kickoff).toBeUndefined();
	});
});

describe("buildComposeUserMessage", () => {
	it("passes a goal through as the focus for Next steps", () => {
		const message = buildComposeUserMessage("[User]: hi", "finish the reader");
		expect(message).toContain("[User]: hi");
		expect(message).toContain("finish the reader");
		expect(message).toContain('Use this to write the "Next steps" section.');
	});

	it("asks the model to infer a next step when no goal is given", () => {
		const message = buildComposeUserMessage("[User]: hi", "");
		expect(message).toContain("No goal was given");
	});
});

describe("composeNoteBody", () => {
	/**
	 * `complete()` resolves rather than rejecting, including on provider errors, so the
	 * stub returns messages instead of throwing — that is the contract under test.
	 */
	function stubRegistry(response: Partial<AssistantMessage>): ModelRegistry {
		return {
			complete: async () => ({ content: [], stopReason: "stop", ...response }) as AssistantMessage,
		} as unknown as ModelRegistry;
	}

	const options = {
		model: {} as never,
		conversationText: "[User]: hi",
		goal: "",
		sessionId: "test-session",
	};

	it("returns the composed body and kickoff on success", async () => {
		const registry = stubRegistry({
			content: [{ type: "text", text: "## Context\nWe did work.\n\nKICKOFF: Do the next thing." }],
		});
		expect(await composeNoteBody({ ...options, modelRegistry: registry })).toEqual({
			status: "ok",
			body: "## Context\nWe did work.",
			kickoff: "Do the next thing.",
		});
	});

	it("reports a provider error as failed, carrying the provider's message", async () => {
		const registry = stubRegistry({ stopReason: "error", errorMessage: "input token count exceeds the maximum" });
		expect(await composeNoteBody({ ...options, modelRegistry: registry })).toEqual({
			status: "failed",
			message: "input token count exceeds the maximum",
		});
	});

	it("still reports a provider error when the provider gave no message", async () => {
		const registry = stubRegistry({ stopReason: "error" });
		const result = await composeNoteBody({ ...options, modelRegistry: registry });
		expect(result.status).toBe("failed");
	});

	it("distinguishes an abort from a failure", async () => {
		const registry = stubRegistry({ stopReason: "aborted" });
		expect(await composeNoteBody({ ...options, modelRegistry: registry })).toEqual({ status: "aborted" });
	});

	it("treats an empty response as a failure, not a cancellation", async () => {
		const registry = stubRegistry({ content: [], stopReason: "stop" });
		const result = await composeNoteBody({ ...options, modelRegistry: registry });
		expect(result.status).toBe("failed");
	});
});
