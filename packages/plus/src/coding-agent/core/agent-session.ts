/**
 * Wrapper for packages/coding-agent/src/core/agent-session.ts.
 *
 * Everything passes through to the upstream module except:
 * - AgentSession.compact -> serialized through a per-session queue. Upstream
 *   keeps the manual compaction's abort controller in a singleton field that
 *   any overlapping compaction's cleanup resets to undefined; overlapping
 *   manual compactions (e.g. context-guard's resume compaction plus a user
 *   /compact) then crash with "Cannot read properties of undefined (reading
 *   'signal')" and never emit compaction_end, stranding the TUI's compaction
 *   indicator (see compaction/serialize.ts).
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
import type { CompactionResult } from "../../../../coding-agent/src/core/compaction/compaction.ts";
import type { ContextUsage } from "../../../../coding-agent/src/core/extensions/types.ts";
import { createAsyncSerializer } from "../../compaction/serialize.ts";
import { applyIdleMicroCompact } from "../../context/microcompact.ts";
import { getContextUsagePlus } from "../../context/usage.ts";

export class AgentSession extends UpstreamAgentSession {
	// Serializes manual compact() calls (resume-triggered, /compact, RPC, SDK)
	// so only one runs at a time; the queue waits for the previous compaction's
	// finally blocks as well, which is exactly what prevents the shared abort
	// controller from being cleared mid-handoff.
	private readonly serializeCompaction = createAsyncSerializer();

	constructor(config: AgentSessionConfig) {
		super(config);
		try {
			applyIdleMicroCompact(this.sessionManager);
		} catch (error) {
			// Micro-compact must never break session construction.
			console.error("pi-plus: idle micro-compact failed:", error);
		}
	}

	override compact(customInstructions?: string): Promise<CompactionResult> {
		return this.serializeCompaction(() => super.compact(customInstructions));
	}

	override getContextUsage(): ContextUsage | undefined {
		return getContextUsagePlus(this);
	}
}
