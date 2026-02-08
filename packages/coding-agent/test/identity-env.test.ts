import { describe, expect, it } from "vitest";
import { ensureIdentityEnv } from "../src/identity-env.js";

describe("ensureIdentityEnv", () => {
	it("sets MU_SESSION_ID and generates MU_RUN_ID if missing", () => {
		delete process.env.MU_SESSION_ID;
		delete process.env.MU_RUN_ID;

		const out = ensureIdentityEnv("session-123");
		expect(out.sessionId).toBe("session-123");
		expect(out.runId.length).toBeGreaterThan(10);
		expect(process.env.MU_SESSION_ID).toBe("session-123");
		expect(process.env.MU_RUN_ID).toBe(out.runId);
	});

	it("does not overwrite an existing MU_RUN_ID", () => {
		process.env.MU_SESSION_ID = "old";
		process.env.MU_RUN_ID = "run-existing";

		const out = ensureIdentityEnv("session-456");
		expect(out.sessionId).toBe("session-456");
		expect(out.runId).toBe("run-existing");
	});
});
