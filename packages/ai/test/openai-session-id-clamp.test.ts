import { describe, expect, it } from "vitest";
import { clampSessionIdHeader, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH } from "../src/api/openai-prompt-cache.ts";

describe("clampSessionIdHeader (#6630)", () => {
	it("returns undefined for undefined input (no header to send)", () => {
		expect(clampSessionIdHeader(undefined)).toBeUndefined();
	});

	it("returns a short session id unchanged", () => {
		const short = "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3";
		expect(clampSessionIdHeader(short)).toBe(short);
	});

	it("returns an exactly-64-char id unchanged", () => {
		const exact = "a".repeat(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
		expect(clampSessionIdHeader(exact)).toBe(exact);
		expect(clampSessionIdHeader(exact)).toHaveLength(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
	});

	it("clamps an id longer than 64 chars to 64 (the Codex backend's prompt_cache_key limit)", () => {
		// A long sessionId — e.g. a ~150-char Claude Code metadata.user_id mapped
		// to sessionId by a proxy — made every request fail with HTTP 400
		// `[prompt_cache_key] [string_above_max_length]` because the raw value was
		// sent in the session-id / x-client-request-id headers unclamped, while
		// the body's prompt_cache_key was already clamped (#6630).
		const long = "a".repeat(150);
		const clamped = clampSessionIdHeader(long);
		expect(clamped).not.toBe(long);
		expect(clamped).toHaveLength(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
	});

	it("clamps a multibyte id by grapheme count, matching the body clamp", () => {
		// Array.from(...) splits by code point, the same approach the body field's
		// clamp uses — keep them consistent so a header and body for the same
		// session agree.
		const long = "𝕏".repeat(80); // 80 code points, each 2 UTF-16 units
		const clamped = clampSessionIdHeader(long);
		expect(Array.from(clamped ?? "").length).toBe(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
	});
});
