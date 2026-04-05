import type { Agent } from "@kennyfrc/mu-agent-core";
import { findRepoRoot } from "../utils/find-repo-root.js";
import { deriveArtifactMemoryEntriesFromToolResult } from "./artifact-trigger.js";
import { enqueueArtifactMemoryWrite } from "./background-write.js";
import { normalizeArtifactMemoryWorkspaceRef } from "./store.js";

export interface ArtifactMemoryRuntimeOptions {
	baseDir?: string;
	cwd?: string;
	onWarning?: (message: string) => void;
}

export function installArtifactMemoryRuntime(agent: Agent, options: ArtifactMemoryRuntimeOptions = {}): void {
	const cwd = options.cwd ?? process.cwd();
	const workspaceRef = normalizeArtifactMemoryWorkspaceRef(findRepoRoot(cwd) ?? cwd);

	agent.subscribe((event) => {
		if (event.type !== "tool_execution_end" || event.isError || typeof event.result === "string") {
			return;
		}

		const toolResult = {
			role: "toolResult" as const,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			content: event.result.content,
			details: event.result.details,
			isError: false,
			timestamp: Date.now(),
		};
		const entries = deriveArtifactMemoryEntriesFromToolResult(toolResult, { workspaceRef });
		if (entries.length === 0) {
			return;
		}

		enqueueArtifactMemoryWrite({
			entries,
			workspaceRef,
			baseDir: options.baseDir,
			onWarning: options.onWarning,
		});
	});
}
