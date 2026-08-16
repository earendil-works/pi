/**
 * Closed-network security fork: the fd/rg binary downloader (utils/tools-manager.ts) must not
 * touch the network when SPI_OFFLINE is set. Mirrors the env-var save/restore pattern used in
 * test/package-manager.test.ts.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { ensureTool, isOfflineModeEnabled } from "../src/utils/tools-manager.js";

describe("isOfflineModeEnabled", () => {
	let previousOfflineEnv: string | undefined;

	beforeEach(() => {
		previousOfflineEnv = process.env.SPI_OFFLINE;
	});

	afterEach(() => {
		if (previousOfflineEnv === undefined) {
			delete process.env.SPI_OFFLINE;
		} else {
			process.env.SPI_OFFLINE = previousOfflineEnv;
		}
	});

	it("is false when SPI_OFFLINE is unset", () => {
		delete process.env.SPI_OFFLINE;
		expect(isOfflineModeEnabled()).toBe(false);
	});

	it("is false when SPI_OFFLINE is empty", () => {
		process.env.SPI_OFFLINE = "";
		expect(isOfflineModeEnabled()).toBe(false);
	});

	it.each(["1", "true", "TRUE", "yes", "YES"])("is true when SPI_OFFLINE=%s", (value) => {
		process.env.SPI_OFFLINE = value;
		expect(isOfflineModeEnabled()).toBe(true);
	});

	it.each(["0", "false", "no", "enabled"])("is false when SPI_OFFLINE=%s", (value) => {
		process.env.SPI_OFFLINE = value;
		expect(isOfflineModeEnabled()).toBe(false);
	});
});

describe("ensureTool() offline mode", () => {
	// getToolsDir() (utils/tools-manager.ts) reads ENV_AGENT_DIR at call time, so redirecting it
	// to a fresh temp dir here guarantees no fd/rg binary is already present — isolated from
	// whatever real state ~/.spi/agent/bin happens to be in (e.g. another test's CLI subprocess
	// may have downloaded one for real, which previously made this test flaky).
	let tempDir: string;
	let previousOfflineEnv: string | undefined;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		previousOfflineEnv = process.env.SPI_OFFLINE;
		previousAgentDir = process.env[ENV_AGENT_DIR];

		tempDir = join(tmpdir(), `tools-manager-offline-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		process.env[ENV_AGENT_DIR] = tempDir;
	});

	afterEach(() => {
		if (previousOfflineEnv === undefined) {
			delete process.env.SPI_OFFLINE;
		} else {
			process.env.SPI_OFFLINE = previousOfflineEnv;
		}
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("returns undefined and never calls fetch when SPI_OFFLINE=1", async () => {
		process.env.SPI_OFFLINE = "1";
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const result = await ensureTool("fd", true);

		expect(result).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("returns undefined and never calls fetch when SPI_OFFLINE=true", async () => {
		process.env.SPI_OFFLINE = "true";
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		// "fd", not "rg": ripgrep is commonly pre-installed system-wide on dev machines, and
		// getToolPath()'s commandExists() PATH check runs regardless of the isolated TOOLS_DIR
		// above, which would short-circuit this before it ever reaches the offline gate.
		const result = await ensureTool("fd", true);

		expect(result).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("attempts a network call when SPI_OFFLINE is unset", async () => {
		delete process.env.SPI_OFFLINE;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled in test"));

		// Rejects/undefined either way once the mocked fetch throws; what matters is that the
		// offline gate did not short-circuit before reaching the network call.
		await ensureTool("fd", true).catch(() => undefined);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});
