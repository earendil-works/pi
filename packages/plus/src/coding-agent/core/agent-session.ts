/**
 * Wrapper for packages/coding-agent/src/core/agent-session.ts.
 *
 * Everything passes through to the upstream module except:
 * - AgentSession.getContextUsage -> estimates context right after compaction instead
 *   of reporting "unknown" (see plus/src/context/usage.ts)
 */
export * from "../../../../coding-agent/src/core/agent-session.ts";

import { AgentSession as UpstreamAgentSession } from "../../../../coding-agent/src/core/agent-session.ts";
import type { ContextUsage } from "../../../../coding-agent/src/core/extensions/types.ts";
import { getContextUsagePlus } from "../../context/usage.ts";

export class AgentSession extends UpstreamAgentSession {
	override getContextUsage(): ContextUsage | undefined {
		return getContextUsagePlus(this);
	}
}
