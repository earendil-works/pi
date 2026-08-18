import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.SPI_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.SPI_EXPERIMENTAL;
		} else {
			process.env.SPI_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when SPI_EXPERIMENTAL is unset", () => {
		delete process.env.SPI_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when SPI_EXPERIMENTAL is empty", () => {
		process.env.SPI_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when SPI_EXPERIMENTAL is set to 1", () => {
		process.env.SPI_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when SPI_EXPERIMENTAL is set to 0", () => {
		process.env.SPI_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when SPI_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.SPI_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
