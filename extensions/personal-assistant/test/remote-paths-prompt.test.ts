import { describe, expect, it } from "vitest";
import { buildRemotePathsPrompt } from "../tools.ts";

describe("buildRemotePathsPrompt", () => {
	it("empty configs → empty string", () => {
		expect(buildRemotePathsPrompt([])).toBe("");
	});

	it("one satellite with pattern → injects prompt", () => {
		const configs = [{ name: "satellite", remotePathPattern: "/TJPROJ\\d+" }];
		const result = buildRemotePathsPrompt(configs);
		expect(result).toContain("## Remote Paths");
		expect(result).toContain("/TJPROJ\\d+");
		expect(result).toContain("satellite_remote_exec");
	});

	it("one satellite without pattern → empty string", () => {
		const configs = [{ name: "satellite", remotePathPattern: undefined }];
		expect(buildRemotePathsPrompt(configs)).toBe("");
	});

	it("non-satellite server with pattern → empty string (only satellite triggers)", () => {
		const configs = [{ name: "other-server", remotePathPattern: "/some/path" }];
		expect(buildRemotePathsPrompt(configs)).toBe("");
	});

	it("multiple satellites with patterns → concatenated", () => {
		// Only configs with name "satellite" trigger (not "satellite2")
		const configs = [
			{ name: "satellite", remotePathPattern: "/TJPROJ\\d+" },
			{ name: "other-server", remotePathPattern: "/data/.*" },
			{ name: "satellite", remotePathPattern: "/project/.*" },
		];
		const result = buildRemotePathsPrompt(configs);
		// Should contain both satellite patterns
		expect(result).toContain("/TJPROJ\\d+");
		expect(result).toContain("/project/.*");
		// Should NOT contain other-server pattern
		expect(result).not.toContain("/data/.*");
		// Should appear twice (two separate sections for satellite)
		const matches = result.match(/## Remote Paths/g);
		expect(matches).toHaveLength(2);
	});

	it("satellite with empty string pattern → empty string", () => {
		const configs = [{ name: "satellite", remotePathPattern: "" }];
		// Empty string pattern should be treated as no pattern
		expect(buildRemotePathsPrompt(configs)).toBe("");
	});
});
