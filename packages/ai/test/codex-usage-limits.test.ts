import { describe, expect, it } from "vitest";
import { parseCodexRateLimits } from "../src/providers/openai-codex/response-handler.js";

describe("parseCodexRateLimits", () => {
	it("extracts primary and secondary usage windows from response headers", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "72",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": "1730000000",
			"x-codex-secondary-used-percent": "40",
			"x-codex-secondary-window-minutes": "10080",
		});

		expect(parseCodexRateLimits(headers)).toEqual({
			primary: { used_percent: 72, window_minutes: 300, resets_at: 1730000000 },
			secondary: { used_percent: 40, window_minutes: 10080, resets_at: undefined },
		});
	});
});
