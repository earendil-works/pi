/**
 * Built-in sub-agent definitions, used when the user has not defined any
 * markdown agents (or explicitly asks for them by name). Defined in code so
 * the subagent tool is useful out of the box.
 */

import type { AgentConfig } from "./agents.ts";

export function getBuiltinAgents(): AgentConfig[] {
	return [
		{
			name: "worker",
			description: "General-purpose agent with the full toolset",
			systemPrompt:
				"You are a general-purpose sub-agent with access to the full toolset. " +
				"Complete the task you are given and reply with a concise final summary of the outcome.",
			source: "builtin",
			filePath: "",
		},
		{
			name: "explore",
			description: "Read-only search agent for exploring codebases",
			tools: ["read", "grep", "find", "ls"],
			systemPrompt:
				"You are a read-only exploration sub-agent. Search and read code to answer the question; " +
				"do not modify any files. Reply with a concise summary of your findings, " +
				"including exact file paths and line references.",
			source: "builtin",
			filePath: "",
		},
	];
}
