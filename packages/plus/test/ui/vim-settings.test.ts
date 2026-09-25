// Tests for the "vim" settings flag reader (project > agent dir > ~/.pi).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

// Isolate from the real home directory: settings.ts falls back to ~/.pi/settings.json.
vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: () => fakeHome };
});

let fakeHome: string;
let agentDir: string;
let projectDir: string;
let cwdDir: string;

const { readVimEnabled, writeVimEnabled } = await import("../../src/coding-agent/ui/vim/settings.ts");

function writeSettings(dir: string, contents: unknown): void {
	writeFileSync(join(dir, "settings.json"), typeof contents === "string" ? contents : JSON.stringify(contents));
}

beforeEach(() => {
	fakeHome = mkdtempSync(join(tmpdir(), "vim-settings-home-"));
	agentDir = mkdtempSync(join(tmpdir(), "vim-settings-agent-"));
	projectDir = mkdtempSync(join(tmpdir(), "vim-settings-project-"));
	cwdDir = mkdtempSync(join(tmpdir(), "vim-settings-cwd-"));
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	mkdirSync(join(fakeHome, ".pi"), { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(fakeHome, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
	rmSync(cwdDir, { recursive: true, force: true });
});

describe("readVimEnabled", () => {
	it("defaults to false when no settings file mentions vim", () => {
		assert.equal(readVimEnabled(cwdDir), false);
	});

	it("reads the flag from the project .pi/settings.json", () => {
		writeSettings(join(projectDir, ".pi"), { vim: true });
		assert.equal(readVimEnabled(projectDir), true);
	});

	it("reads the flag from the agent dir settings.json", () => {
		writeSettings(agentDir, { vim: true });
		assert.equal(readVimEnabled(cwdDir), true);
	});

	it("reads the flag from ~/.pi/settings.json", () => {
		writeSettings(join(fakeHome, ".pi"), { vim: true });
		assert.equal(readVimEnabled(cwdDir), true);
	});

	it("project settings win over the agent dir", () => {
		writeSettings(join(projectDir, ".pi"), { vim: false });
		writeSettings(agentDir, { vim: true });
		assert.equal(readVimEnabled(projectDir), false);
	});

	it("agent dir settings win over ~/.pi", () => {
		writeSettings(agentDir, { vim: false });
		writeSettings(join(fakeHome, ".pi"), { vim: true });
		assert.equal(readVimEnabled(cwdDir), false);
	});

	it("a project setting is scoped to its own cwd", () => {
		writeSettings(join(projectDir, ".pi"), { vim: true });
		assert.equal(readVimEnabled(cwdDir), false);
		assert.equal(readVimEnabled(projectDir), true);
	});

	it("malformed JSON is ignored", () => {
		writeSettings(agentDir, "{ not json");
		assert.equal(readVimEnabled(cwdDir), false);
	});

	it("non-boolean values are ignored (fall through to the next source)", () => {
		writeSettings(agentDir, { vim: "yes" });
		assert.equal(readVimEnabled(cwdDir), false);
		writeSettings(join(fakeHome, ".pi"), { vim: true });
		assert.equal(readVimEnabled(cwdDir), true);
	});
});

describe("writeVimEnabled", () => {
	it("writes the flag and preserves other keys", () => {
		writeSettings(agentDir, { theme: "dark", model: "kimi" });
		assert.equal(writeVimEnabled(true), true);
		assert.equal(readVimEnabled(cwdDir), true);
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		assert.equal(raw.theme, "dark");
		assert.equal(raw.model, "kimi");
		assert.equal(raw.vim, true);
	});

	it("overwrites an existing flag", () => {
		writeVimEnabled(true);
		assert.equal(writeVimEnabled(false), true);
		assert.equal(readVimEnabled(cwdDir), false);
	});

	it("creates the settings file when missing", () => {
		const path = join(agentDir, "settings.json");
		if (existsSync(path)) rmSync(path);
		assert.equal(writeVimEnabled(true), true);
		assert.equal(readVimEnabled(cwdDir), true);
	});

	it("the persisted flag is still overridable per project", () => {
		writeVimEnabled(true);
		writeSettings(join(projectDir, ".pi"), { vim: false });
		assert.equal(readVimEnabled(projectDir), false);
	});
});
