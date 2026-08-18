import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.PI_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.PI_EXPERIMENTAL;
		} else {
			process.env.PI_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when PI_EXPERIMENTAL is unset", () => {
		delete process.env.PI_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when PI_EXPERIMENTAL is empty", () => {
		process.env.PI_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when PI_EXPERIMENTAL is set to 1", () => {
		process.env.PI_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when PI_EXPERIMENTAL is set to 0", () => {
		process.env.PI_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when PI_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.PI_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
