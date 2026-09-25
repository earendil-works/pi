import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
let profiles: typeof import("../../src/profiles.ts");

function setup() {
	vi.resetModules();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hub-profiles-test-"));
	process.env.PI_HUB_PI_DIR = tmpDir;
	process.env.PI_HUB_PROFILES_FILE = path.join(tmpDir, "profiles.json");
	process.env.PI_HUB_DIR = path.join(tmpDir, "pi-hub");
	process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "agent");
}

async function load() {
	profiles = await import("../../src/profiles.ts");
}

function teardown() {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	delete process.env.PI_HUB_PI_DIR;
	delete process.env.PI_HUB_PROFILES_FILE;
	delete process.env.PI_HUB_DIR;
	delete process.env.PI_CODING_AGENT_DIR;
}

describe("profiles CRUD", () => {
	beforeEach(async () => {
		setup();
		await load();
	});
	afterEach(teardown);

	it("addProfile creates the profiles file with mode 0600", () => {
		profiles.addProfile("work", { provider: "kimi-coding", model: "kimi-k2.7" });
		const data = profiles.loadProfiles();
		expect(data.profiles.work).toEqual({ provider: "kimi-coding", model: "kimi-k2.7" });
		const mode = fs.statSync(process.env.PI_HUB_PROFILES_FILE as string).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("updateProfile throws for an unknown profile", () => {
		expect(() => profiles.updateProfile("ghost", {})).toThrow("not found");
	});

	it("removeProfile clears the default when the default is removed", () => {
		profiles.addProfile("work", {});
		profiles.setDefaultProfile("work");
		profiles.removeProfile("work");
		const data = profiles.loadProfiles();
		expect(data.profiles.work).toBeUndefined();
		expect(data.default).toBeUndefined();
	});

	it("renameProfile moves the profile and the default marker", () => {
		profiles.addProfile("old", { model: "m1" });
		profiles.setDefaultProfile("old");
		profiles.renameProfile("old", "new");
		const data = profiles.loadProfiles();
		expect(data.profiles.old).toBeUndefined();
		expect(data.profiles.new).toEqual({ model: "m1" });
		expect(data.default).toBe("new");
	});

	it("renameProfile throws when the target name exists", () => {
		profiles.addProfile("a", {});
		profiles.addProfile("b", {});
		expect(() => profiles.renameProfile("a", "b")).toThrow("already exists");
	});

	it("setDefaultProfile throws for an unknown profile", () => {
		expect(() => profiles.setDefaultProfile("ghost")).toThrow("not found");
	});

	it("default round-trip: set, read, clear", () => {
		profiles.addProfile("work", {});
		expect(profiles.getDefaultProfileName()).toBeUndefined();

		profiles.setDefaultProfile("work");
		expect(profiles.getDefaultProfileName()).toBe("work");

		profiles.clearDefaultProfile();
		expect(profiles.getDefaultProfileName()).toBeUndefined();
		// Stored as the built-in marker for backward compatibility
		expect(profiles.loadProfiles().default).toBe("__builtin__");
	});
});

describe("helpers", () => {
	beforeEach(async () => {
		setup();
		await load();
	});
	afterEach(teardown);

	it("maskToken shows first8...last4 for long tokens", () => {
		expect(profiles.maskToken("sk-abcdefgh1234wxyz")).toBe("sk-abcde...wxyz");
		expect(profiles.maskToken("short")).toBe("short");
		expect(profiles.maskToken("")).toBe("(unset)");
	});

	it("formatModels truncates long lists", () => {
		expect(profiles.formatModels({})).toBe("(unset)");
		expect(profiles.formatModels({ model: "m1" })).toBe("m1");
		expect(profiles.formatModels({ models: ["m1", "m2", "m3"] })).toBe("m1, m2, m3");
		expect(
			profiles.formatModels({ models: ["a-very-long-model-name", "another-quite-long-model", "third-model"] }),
		).toBe("a-very-long-model-name, +2 more");
	});

	it("validateThinking accepts known levels and rejects others", () => {
		expect(() => profiles.validateThinking("high")).not.toThrow();
		expect(() => profiles.validateThinking("nope")).toThrow("Invalid thinking level");
		expect(() => profiles.validateThinking(undefined)).not.toThrow();
	});

	it("parseSetValue parses JSON when possible", () => {
		expect(profiles.parseSetValue("42")).toBe(42);
		expect(profiles.parseSetValue("true")).toBe(true);
		expect(profiles.parseSetValue("null")).toBe(null);
		expect(profiles.parseSetValue("hello")).toBe("hello");
	});

	it("mergeModelsUpdate selects an existing single model", () => {
		const merged = profiles.mergeModelsUpdate(["m1", "m2"], ["m2"]);
		expect(merged.models).toEqual(["m2", "m1"]);
		expect(merged.messages[0]).toContain("position 2 -> 1");
	});

	it("mergeModelsUpdate unshifts a new single model", () => {
		const merged = profiles.mergeModelsUpdate(["m1"], ["m2"]);
		expect(merged.models).toEqual(["m2", "m1"]);
	});

	it("mergeModelsUpdate replaces the list when multiple models are given", () => {
		const merged = profiles.mergeModelsUpdate(["m1", "m2"], ["m3", "m4"]);
		expect(merged.models).toEqual(["m3", "m4"]);
	});
});
