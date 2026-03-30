/**
 * Full Control
 *
 * Replace everything - no discovery, explicit configuration.
 *
 * IMPORTANT: When providing `tools` with a custom `cwd`, use the tool factory
 * functions (createReadTool, createBashTool, etc.) to ensure tools resolve
 * paths relative to your cwd.
 */

import { getModel } from "@mariozechner/pi-ai";
import {
	AuthStorage,
	createAgentSession,
	createBashTool,
	createExtensionRuntime,
	createReadTool,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";

// Custom auth storage location
const authStorage = AuthStorage.create("/tmp/my-agent/auth.json");

// Runtime API key override (not persisted)
if (process.env.MY_ANTHROPIC_KEY) {
	authStorage.setRuntimeApiKey("anthropic", process.env.MY_ANTHROPIC_KEY);
}

// Model registry with no custom models.json
const modelRegistry = ModelRegistry.inMemory(authStorage);

const model = getModel("anthropic", "claude-sonnet-4-20250514");
if (!model) throw new Error("Model not found");

// In-memory settings with overrides
const settingsManager = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: true, maxRetries: 2 },
});

// When using a custom cwd with explicit tools, use the factory functions
const cwd = process.cwd();

const resourceLoader: ResourceLoader = {
	getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => `You are a minimal assistant.
Available: read, bash. Be concise.`,
	getAppendSystemPrompt: () => [],
	extendResources: () => {},
	reload: async () => {},
};

const { session } = await createAgentSession({
	cwd,
	agentDir: "/tmp/my-agent",
	model,
	thinkingLevel: "off",
	authStorage,
	modelRegistry,
	resourceLoader,
	// Use factory functions with the same cwd to ensure path resolution works correctly
	tools: [createReadTool(cwd), createBashTool(cwd)],
	sessionManager: SessionManager.inMemory(),
	settingsManager,
});

session.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

await session.prompt("List files in the current directory.");
console.log();
