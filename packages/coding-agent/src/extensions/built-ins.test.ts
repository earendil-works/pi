import { describe, expect, it } from "vitest";
import { builtInExtensions } from "./built-ins.js";

describe("builtInExtensions", () => {
	it("includes the built-in ask_user preset", () => {
		expect(builtInExtensions.map((entry) => entry.sourceId)).toContain("preset:ask-user");
	});
});
