import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	applySignIn,
	computeBindingRequirement,
	ensureValidAuth,
	needsRefresh,
} from "../src/core/matwings-auth/session.ts";
import { clearTokens, loadTokens } from "../src/core/matwings-auth/storage.ts";

const tmp = mkdtempSync(join(tmpdir(), "matvenus-session-"));

beforeAll(() => {
	process.env.MATVENUS_CODING_AGENT_DIR = tmp;
});
afterAll(() => {
	delete process.env.MATVENUS_CODING_AGENT_DIR;
	rmSync(tmp, { recursive: true, force: true });
});

const future = "2099-01-01T00:00:00Z";

describe("matwings-auth session", () => {
	it("needsRefresh respects the 10-min buffer", () => {
		const now = 1_000_000;
		expect(needsRefresh(now + 5 * 60 * 1000, now)).toBe(true);
		expect(needsRefresh(now + 30 * 60 * 1000, now)).toBe(false);
		expect(needsRefresh(now - 1, now)).toBe(true);
	});

	it("applySignIn persists and is loadable", async () => {
		const stored = await applySignIn({
			access_token: "a",
			refresh_token: "r",
			expires_at: future,
			token_type: "bearer",
			user: { id: 7, name: "n" },
		});
		expect(stored.access_token).toBe("a");
		expect(stored.expires_at).toBe(Date.parse(future));
		expect((await loadTokens())?.user.id).toBe(7);
	});

	it("ensureValidAuth returns stored auth when fresh", async () => {
		await applySignIn({
			access_token: "fresh",
			refresh_token: "r",
			expires_at: future,
			token_type: "bearer",
			user: { id: 1, name: "x" },
		});
		expect((await ensureValidAuth())?.access_token).toBe("fresh");
	});

	it("ensureValidAuth returns null when nothing is stored", async () => {
		await clearTokens();
		expect(await ensureValidAuth()).toBeNull();
	});

	it("computeBindingRequirement honours force flags", () => {
		const base = {
			access_token: "a",
			refresh_token: "r",
			expires_at: future,
			token_type: "bearer",
			user: { id: 1, name: "x" },
		};
		expect(
			computeBindingRequirement(
				{ ...base, binding_required: true, binding_type: "phone" },
				{ force_phone_binding: true },
			),
		).toEqual({ type: "phone", mandatory: true });
		expect(
			computeBindingRequirement(
				{ ...base, binding_required: true, binding_type: "email" },
				{ force_email_binding: false },
			),
		).toEqual({ type: "email", mandatory: false });
		expect(computeBindingRequirement({ ...base })).toBeNull();
	});
});
