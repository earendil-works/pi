import { randomUUID } from "crypto";

export interface IdentityEnv {
	sessionId: string;
	runId: string;
}

/**
 * Ensure MU_SESSION_ID and MU_RUN_ID are set in process.env.
 *
 * - sessionId should come from SessionManager.getSessionId().
 * - runId is generated once per process invocation.
 */
export function ensureIdentityEnv(sessionId: string): IdentityEnv {
	if (sessionId.trim().length > 0) {
		process.env.MU_SESSION_ID = sessionId;
	}

	if (!process.env.MU_RUN_ID || process.env.MU_RUN_ID.trim().length === 0) {
		process.env.MU_RUN_ID = randomUUID();
	}

	const finalSessionId = process.env.MU_SESSION_ID;
	const finalRunId = process.env.MU_RUN_ID;

	if (!finalSessionId) {
		throw new Error("MU_SESSION_ID is not set");
	}
	if (!finalRunId) {
		throw new Error("MU_RUN_ID is not set");
	}

	return { sessionId: finalSessionId, runId: finalRunId };
}
