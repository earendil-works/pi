import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	clearTokens,
	getAuthFilePath,
	loadTokens,
	saveTokens,
	type StoredAuth,
} from "../src/core/matwings-auth/storage.ts";

const tmp = mkdtempSync(join(tmpdir(), "matvenus-auth-"));

beforeAll(() => {
	process.env.MATVENUS_CODING_AGENT_DIR = tmp;
});
afterAll(() => {
	delete process.env.MATVENUS_CODING_AGENT_DIR;
	rmSync(tmp, { recursive: true, force: true });
});

const sample: StoredAuth = {
	access_token: "a",
	refresh_token: "r",
	expires_at: Date.now() + 1_000_000,
	user: { id: 1, name: "x" },
};

beforeEach(async () => {
	await clearTokens();
});

describe("matwings-auth storage", () => {
	it("returns null when absent", async () => {
		expect(await loadTokens()).toBeNull();
	});

	it("round-trips and is written 0o600", async () => {
		await saveTokens(sample);
		const loaded = await loadTokens();
		expect(loaded?.access_token).toBe("a");
		expect(loaded?.user.id).toBe(1);
		const mode = statSync(getAuthFilePath()).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("clear removes the file", async () => {
		await saveTokens(sample);
		await clearTokens();
		expect(await loadTokens()).toBeNull();
	});
});
