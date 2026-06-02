import { AGENTS_ENGINE_SERVICE_ID, type AgentEngine } from "../agents/engine.ts";
import { formatAgentFooterStatus } from "../agents/status.ts";
import {
	createAgentToolDefinition,
	createTaskToolDefinition,
	createUppercaseAgentToolDefinition,
} from "../tools/agent.ts";
import { addAction, load } from "./extension-hooks.ts";
import type { ExtensionAPI } from "./types.ts";

function getAgentEngine(pi: ExtensionAPI): AgentEngine | undefined {
	return pi.harness.use<AgentEngine>(AGENTS_ENGINE_SERVICE_ID);
}

export function hookAgents(pi: ExtensionAPI): void {
	const options = {
		getEngine: () => getAgentEngine(pi),
		getParentModel: () => getAgentEngine(pi)?.snapshot().model,
		getParentThinkingLevel: () => getAgentEngine(pi)?.snapshot().thinkingLevel ?? "off",
	};
	pi.registerTool(createAgentToolDefinition("", options));
	pi.registerTool(createUppercaseAgentToolDefinition("", options));
	pi.registerTool(createTaskToolDefinition("", options));

	// Background-agent status pill ("Agents: 1 running · ..."). Reactive
	// visibility: the pill appears only when there are active background runs.
	pi.registerFooter("agents-status", {
		render: () => formatAgentFooterStatus() ?? "",
		visible: () => formatAgentFooterStatus() !== undefined,
		onActivate: () => {},
	});
}

addAction(load, "agents", hookAgents);
