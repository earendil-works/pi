/**
 * Wrapper for packages/coding-agent/src/core/agent-session.ts.
 *
 * Everything passes through to the upstream module except:
 * - AgentSession.getContextUsage -> estimates context right after compaction instead
 *   of reporting "unknown" (see plus/src/context/usage.ts)
 * - AgentSession constructor -> applies time-based micro-compact (clearing stale
 *   tool results) once per (re)opened session, before the first request rebuilds
 *   the dead prompt-cache prefix (see plus/src/context/microcompact.ts)
 */
export * from "../../../../coding-agent/src/core/agent-session.ts";

import {
	type AgentSessionConfig,
	AgentSession as UpstreamAgentSession,
} from "../../../../coding-agent/src/core/agent-session.ts";
import type { ContextUsage } from "../../../../coding-agent/src/core/extensions/types.ts";
import { applyIdleMicroCompact } from "../../context/microcompact.ts";
import { getContextUsagePlus } from "../../context/usage.ts";

export class AgentSession extends UpstreamAgentSession {
	constructor(config: AgentSessionConfig) {
		super(config);
		try {
			applyIdleMicroCompact(this.sessionManager);
		} catch (error) {
			// Micro-compact must never break session construction.
			console.error("pi-plus: idle micro-compact failed:", error);
		}
	}

	override getContextUsage(): ContextUsage | undefined {
		return getContextUsagePlus(this);
	}
}
