import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateManager } from "../src/core/state-manager.js";

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("StateManager", () => {
	let tempDir: string;
	let agentDir: string;
	let statePath: string;
	let settingsPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-state-manager-${randomUUID()}`);
		agentDir = join(tempDir, "agent");
		statePath = join(agentDir, "state.json");
		settingsPath = join(agentDir, "settings.json");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("persists lastChangelogVersion to state.json", async () => {
		const manager = StateManager.create(agentDir);

		manager.setLastChangelogVersion("0.74.0");
		await manager.flush();

		expect(readJson(statePath)).toEqual({ lastChangelogVersion: "0.74.0" });
		expect(StateManager.create(agentDir).getLastChangelogVersion()).toBe("0.74.0");
	});

	it("supports in-memory state", async () => {
		const manager = StateManager.inMemory({ lastChangelogVersion: "0.73.0" });

		expect(manager.getLastChangelogVersion()).toBe("0.73.0");

		manager.setLastChangelogVersion("0.74.0");
		await manager.flush();

		expect(manager.getLastChangelogVersion()).toBe("0.74.0");
	});

	it("preserves unknown state fields when saving", async () => {
		writeFileSync(statePath, JSON.stringify({ customState: true, lastChangelogVersion: "0.73.0" }));
		const manager = StateManager.create(agentDir);

		manager.setLastChangelogVersion("0.74.0");
		await manager.flush();

		expect(readJson(statePath)).toEqual({ customState: true, lastChangelogVersion: "0.74.0" });
	});

	it("reports state load errors", () => {
		writeFileSync(statePath, "{ invalid json");

		const manager = StateManager.create(agentDir);
		const errors = manager.drainErrors();

		expect(manager.getLastChangelogVersion()).toBeUndefined();
		expect(errors).toHaveLength(1);
		expect(errors[0].source).toBe("state");
		expect(manager.drainErrors()).toEqual([]);
	});

	it("seeds state from legacy settings and removes the legacy setting", () => {
		writeFileSync(settingsPath, JSON.stringify({ lastChangelogVersion: "0.73.0", theme: "dark" }));

		const manager = StateManager.create(agentDir);

		expect(manager.getLastChangelogVersion()).toBe("0.73.0");
		expect(readJson(statePath)).toEqual({ lastChangelogVersion: "0.73.0" });
		expect(readJson(settingsPath)).toEqual({ theme: "dark" });
	});

	it("treats existing state as authoritative and removes stale legacy settings", () => {
		writeFileSync(statePath, JSON.stringify({ lastChangelogVersion: "0.74.0" }));
		writeFileSync(settingsPath, JSON.stringify({ lastChangelogVersion: "0.73.0", theme: "dark" }));

		const manager = StateManager.create(agentDir);

		expect(manager.getLastChangelogVersion()).toBe("0.74.0");
		expect(readJson(statePath)).toEqual({ lastChangelogVersion: "0.74.0" });
		expect(readJson(settingsPath)).toEqual({ theme: "dark" });
	});

	it("keeps legacy settings untouched when state cannot be loaded", () => {
		mkdirSync(statePath);
		writeFileSync(settingsPath, JSON.stringify({ lastChangelogVersion: "0.73.0", theme: "dark" }));

		const manager = StateManager.create(agentDir);
		const errors = manager.drainErrors();

		expect(manager.getLastChangelogVersion()).toBeUndefined();
		expect(errors.some((error) => error.source === "state")).toBe(true);
		expect(readJson(settingsPath)).toEqual({ lastChangelogVersion: "0.73.0", theme: "dark" });
	});
});
