/**
 * Tests for the memory settings reader (plus/src/extensions/memory/settings.ts):
 * precedence (project > agent dir > ~/.pi), partial-object merging with
 * defaults, and garbage tolerance.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "vitest";
import { readMemorySettings } from "../../src/extensions/memory/settings.ts";

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

interface Fixture {
	projectDir: string;
	agentDir: string;
}

function fixture(): Fixture {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-settings-"));
	const projectDir = path.join(base, "project");
	const agentDir = path.join(base, "agent");
	fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	process.env[ENV_AGENT_DIR] = agentDir;
	return { projectDir, agentDir };
}

function writeSettings(dir: string, value: unknown): void {
	fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ memory: value }), "utf8");
}

afterEach(() => {
	delete process.env[ENV_AGENT_DIR];
});

describe("readMemorySettings", () => {
	it("returns defaults when no settings files exist", () => {
		const { projectDir } = fixture();
		assert.deepEqual(readMemorySettings(projectDir), {
			enabled: true,
			autoExtract: true,
			extractMinMessages: 8,
			extractCooldownMs: 180_000,
		});
	});

	it("project settings win over agent dir settings (wholesale, most specific source)", () => {
		const { projectDir, agentDir } = fixture();
		writeSettings(path.join(projectDir, ".pi"), { enabled: false });
		writeSettings(agentDir, { enabled: true, autoExtract: false });
		const settings = readMemorySettings(projectDir);
		assert.equal(settings.enabled, false); // project wins
		assert.equal(settings.autoExtract, true); // untouched keys fall back to defaults
	});

	it("merges a partial object with the defaults", () => {
		const { projectDir } = fixture();
		writeSettings(path.join(projectDir, ".pi"), { extractMinMessages: 20 });
		const settings = readMemorySettings(projectDir);
		assert.equal(settings.extractMinMessages, 20);
		assert.equal(settings.enabled, true);
		assert.equal(settings.autoExtract, true);
		assert.equal(settings.extractCooldownMs, 180_000);
	});

	it("falls back to the agent dir when the project has no memory key", () => {
		const { projectDir, agentDir } = fixture();
		writeSettings(agentDir, { autoExtract: false });
		const settings = readMemorySettings(projectDir);
		assert.equal(settings.autoExtract, false);
		assert.equal(settings.enabled, true);
	});

	it("ignores garbage values and missing files", () => {
		const { projectDir, agentDir } = fixture();
		writeSettings(path.join(projectDir, ".pi"), "nonsense");
		writeSettings(agentDir, { extractCooldownMs: "soon", enabled: 42, autoExtract: true });
		const settings = readMemorySettings(projectDir);
		assert.deepEqual(settings, {
			enabled: true,
			autoExtract: true,
			extractMinMessages: 8,
			extractCooldownMs: 180_000,
		});
	});

	it("survives unparseable settings.json files", () => {
		const { projectDir, agentDir } = fixture();
		fs.writeFileSync(path.join(projectDir, ".pi", "settings.json"), "{ not json", "utf8");
		writeSettings(agentDir, { enabled: false });
		const settings = readMemorySettings(projectDir);
		assert.equal(settings.enabled, false);
	});
});
