/**
 * API Keys and OAuth
 *
 * Configure API key resolution via AuthStorage and ModelRegistry.
 */

import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@lyla/coding-agent";

// Default: AuthStorage uses ~/.pi/agent/auth.json
// ModelRegistry loads built-in + custom models from ~/.pi/agent/models.json
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const { session: defaultAuthSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
console.log("Session with default auth storage and model registry");
defaultAuthSession.dispose();

// Custom auth storage location
const customAuthStorage = AuthStorage.create("/tmp/my-app/auth.json");
const customModelRegistry = ModelRegistry.create(customAuthStorage, "/tmp/my-app/models.json");

const { session: customAuthSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage: customAuthStorage,
	modelRegistry: customModelRegistry,
});
console.log("Session with custom auth storage location");
customAuthSession.dispose();

// Runtime API key override (not persisted to disk)
authStorage.setRuntimeApiKey("anthropic", "sk-my-temp-key");
const { session: runtimeKeySession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
console.log("Session with runtime API key override");
runtimeKeySession.dispose();

// No models.json - only built-in models
const simpleRegistry = ModelRegistry.inMemory(authStorage);
const { session: builtInModelsSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry: simpleRegistry,
});
console.log("Session with only built-in models");
builtInModelsSession.dispose();
