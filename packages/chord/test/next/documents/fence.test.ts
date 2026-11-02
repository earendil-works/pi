// Seal tokens (slice 6a §3, decision "The seal fence"): open until sealed, sealed for good.

import { describe, expect, it } from "vitest";
import { SealToken } from "../../../src/next/documents/internal.ts";

describe("seal tokens", () => {
	it("start open and stay sealed once sealed", () => {
		const token = new SealToken();
		expect(token.sealed).toBe(false);
		token.seal();
		token.seal();
		expect(token.sealed).toBe(true);
	});
});
