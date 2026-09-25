/**
 * Wrapper for packages/agent/src/agent.ts.
 *
 * Pass-through except the Agent class: the stream function is wrapped to apply
 * the Claude Code effort model per request (env overrides, budgets, ultrathink).
 * See plus/src/reasoning/effort.ts.
 */
export * from "../../../agent/src/agent.ts";

import { Agent as UpstreamAgent } from "../../../agent/src/agent.ts";
import { wrapStreamFn } from "../reasoning/effort.ts";

export class Agent extends UpstreamAgent {
	constructor(options: ConstructorParameters<typeof UpstreamAgent>[0]) {
		super(options);
		this.streamFunction = wrapStreamFn(this.streamFunction, () => this.state.thinkingLevel);
	}
}
