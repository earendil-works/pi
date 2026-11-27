import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CompletionsThinkingSignature,
	decodeLegacyToolCallReasoningDetail,
	decodeThinkingSignature,
	encodeThinkingSignature,
} from "../src/api/openai-completions-reasoning.ts";

const encryptedDetail = { type: "reasoning.encrypted", id: "call_1", data: "encrypted" } as const;

describe("openai-completions thinking signature", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each<[string, CompletionsThinkingSignature]>([
		["field", { kind: "field", field: "reasoning_content" }],
		["details", { kind: "details", details: [encryptedDetail] }],
		["opaque with field", { kind: "opaque", field: "reasoning_text", opaque: "opaque-1" }],
		["opaque without field", { kind: "opaque", opaque: "opaque-1" }],
	])("round-trips %s", (_name, signature) => {
		expect(decodeThinkingSignature(encodeThinkingSignature(signature))).toEqual(signature);
	});

	it("reads the stored formats", () => {
		expect(decodeThinkingSignature("reasoning")).toEqual({ kind: "field", field: "reasoning" });
		expect(decodeThinkingSignature(JSON.stringify([encryptedDetail]))).toEqual({
			kind: "details",
			details: [encryptedDetail],
		});
		expect(decodeThinkingSignature('{"field":"reasoning_text","reasoning_opaque":"o"}')).toEqual({
			kind: "opaque",
			field: "reasoning_text",
			opaque: "o",
		});
	});

	it.each([
		undefined,
		"",
		"anthropic-signature",
		"[]",
		"[not json",
		'[{"type":"unknown"}]',
		'{"reasoning_opaque":""}',
		'{"field":"content","reasoning_opaque":"o"}',
		"{not json",
	])("decodes %j as no replay data", (signature) => {
		expect(decodeThinkingSignature(signature)).toBeUndefined();
	});

	it("does not parse signatures that cannot be JSON", () => {
		const parse = vi.spyOn(JSON, "parse");
		decodeThinkingSignature("reasoning_content");
		decodeThinkingSignature("anthropic-signature");
		decodeLegacyToolCallReasoningDetail("google-thought-signature");
		expect(parse).not.toHaveBeenCalled();
	});

	it("reads encrypted details stored on tool calls by older sessions", () => {
		expect(decodeLegacyToolCallReasoningDetail(JSON.stringify(encryptedDetail))).toEqual(encryptedDetail);
		expect(decodeLegacyToolCallReasoningDetail(JSON.stringify({ ...encryptedDetail, id: "" }))).toBeUndefined();
	});
});
