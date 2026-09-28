/**
 * Per-project long-term memory (adapted from openclaude's auto-memory /
 * memdir system): markdown memories with frontmatter (name, description,
 * type) under <agentDir>/memory/<project-key>/, indexed in MEMORY.md and
 * injected into the system prompt so every session recalls them.
 *
 * Surface area:
 * - memory_save / memory_recall tools for the model
 * - <memory> system-prompt section with the MEMORY.md index each turn
 * - /memory command (browse/edit, add, forget, index)
 * - background auto-extraction at agent_settled: a forked pi sub-agent
 *   restricted to the memory tools reviews the conversation and persists
 *   noteworthy facts (skipped when the main agent already saved a memory)
 *
 * Toggled via the "memory" key in settings.json ({ "memory": { "enabled":
 * false, "autoExtract": false, "extractMinMessages": 8, "extractCooldownMs":
 * 180000 } }, project > agent dir > ~/.pi).
 */

import type { ExtensionAPI, ExtensionContext } from "../../../../coding-agent/src/core/extensions/types.ts";
import { registerMemoryCommand } from "./command.ts";
import { createExtractState, type ExtractDeps, maybeExtract } from "./extract.ts";
import { readMemorySettings } from "./settings.ts";
import { MemoryStore } from "./store.ts";
import { registerMemoryTools } from "./tools.ts";

const MEMORY_SECTION_NAME = "memory";

/** Optional seams for tests; production wiring is the default. */
export interface MemoryExtensionOverrides {
	storeFor?: (ctx: ExtensionContext) => MemoryStore;
	runAgent?: ExtractDeps["runAgent"];
}

export function registerMemory(pi: ExtensionAPI, overrides: MemoryExtensionOverrides = {}): void {
	const state = createExtractState();
	const deps: ExtractDeps = {
		storeFor: overrides.storeFor ?? ((ctx: ExtensionContext): MemoryStore => MemoryStore.forCwd(ctx.cwd)),
		runAgent: overrides.runAgent,
	};

	registerMemoryTools(pi, deps);
	registerMemoryCommand(pi, deps);

	// Dedup vs the main agent's own writes: if the model saved a memory during
	// this run, the background extractor stays off for it.
	pi.on("tool_call", async (event) => {
		if (event.toolName === "memory_save") state.mainAgentSavedThisRun = true;
	});

	pi.on("agent_start", async () => {
		state.mainAgentSavedThisRun = false;
	});

	// Recall: inject the MEMORY.md index into the system prompt each run so
	// the model knows what is remembered (and can memory_recall full bodies).
	pi.on("before_agent_start", async (event, ctx) => {
		const settings = readMemorySettings(ctx.cwd);
		if (!settings.enabled) return;
		const index = (await deps.storeFor(ctx).readIndex()).trim();
		if (index === "") return;
		event.systemPromptOptions.sections[MEMORY_SECTION_NAME] =
			"Long-term memory index for this project (use the memory_recall tool to load full contents):\n" + index;
	});

	// Extraction: once per settled user prompt, subject to throttling.
	pi.on("agent_settled", async (_event, ctx) => {
		maybeExtract(ctx, state, deps);
	});
}
