import { describe, expect, it } from "vitest";
import { PI_CAPABILITIES } from "../src/index.ts";

describe("PI_CAPABILITIES", () => {
	it("advertises the pre-dispatch durability barrier", () => {
		expect(PI_CAPABILITIES).toEqual({ inputDurability: "pre_dispatch_barrier" });
	});
});
