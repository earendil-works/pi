/**
 * Shared test utilities for coding-agent tests.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, type OAuthCredentials, type OAuthProvider } from "@mariozechner/pi-ai";
import { getOAuthApiKey } from "@mariozechner/pi-ai/oauth";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createEventBus } from "../src/core/event-bus.js";
import type { Extension, ExtensionFactory, LoadExtensionsResult } from "../src/core/extensions/index.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { ResourceLoader } from "../src/core/resource-loader.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createCodingTools } from "../src/index.js";

/**
 * API key for authenticated tests. Tests using this should be wrapped in
 * describe.skipIf(!API_KEY)
 */
export const API_KEY = process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;

// ============================================================================
// OAuth API key resolution from ~/.pi/agent/auth.json
// ============================================================================

const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

type OAuthCredentialEntry = {
	type: "oauth";
} & OAuthCredentials;

type AuthCredential = ApiKeyCredential | OAuthCredentialEntry;

type AuthStorageData = Record<string, AuthCredential>;

function loadAuthStorage(): AuthStorageData {
	if (!existsSync(AUTH_PATH)) {
		return {};
	}
	try {
		const content = readFileSync(AUTH_PATH, "utf-8");
		return JSON.parse(content);
	} catch {
		return {};
	}
}

function saveAuthStorage(storage: AuthStorageData): void {
	const configDir = dirname(AUTH_PATH);
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
	}
	writeFileSync(AUTH_PATH, JSON.stringify(storage, null, 2), "utf-8");
	chmodSync(AUTH_PATH, 0o600);
}

/**
 * Resolve API key for a provider from ~/.pi/agent/auth.json
 *
 * For API key credentials, returns the key directly.
 * For OAuth credentials, returns the access token (refreshing if expired and saving back).
 *
 * For google-gemini-cli and google-antigravity, returns JSON-encoded { token, projectId }
 */
export async function resolveApiKey(provider: string): Promise<string | undefined> {
	const storage = loadAuthStorage();
	const entry = storage[provider];

	if (!entry) return undefined;

	if (entry.type === "api_key") {
		return entry.key;
	}

	if (entry.type === "oauth") {
		// Build OAuthCredentials record for getOAuthApiKey
		const oauthCredentials: Record<string, OAuthCredentials> = {};
		for (const [key, value] of Object.entries(storage)) {
			if (value.type === "oauth") {
				const { type: _, ...creds } = value;
				oauthCredentials[key] = creds;
			}
		}

		const result = await getOAuthApiKey(provider as OAuthProvider, oauthCredentials);
		if (!result) return undefined;

		// Save refreshed credentials back to auth.json
		storage[provider] = { type: "oauth", ...result.newCredentials };
		saveAuthStorage(storage);

		return result.apiKey;
	}

	return undefined;
}

/**
 * Check if a provider has credentials in ~/.pi/agent/auth.json
 */
export function hasAuthForProvider(provider: string): boolean {
	const storage = loadAuthStorage();
	return provider in storage;
}

/** Path to the real pi agent config directory */
export const PI_AGENT_DIR = join(homedir(), ".pi", "agent");

/**
 * Get an AuthStorage instance backed by ~/.pi/agent/auth.json
 * Use this for tests that need real OAuth credentials.
 */
export function getRealAuthStorage(): AuthStorage {
	return AuthStorage.create(AUTH_PATH);
}

/**
 * Create a minimal user message for testing.
 */
export function userMsg(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

/**
 * Create a minimal assistant message for testing.
 */
export function assistantMsg(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/**
 * Options for creating a test session.
 */
export interface TestSessionOptions {
	/** Use in-memory session (no file persistence) */
	inMemory?: boolean;
	/** Custom system prompt */
	systemPrompt?: string;
	/** Custom settings overrides */
	settingsOverrides?: Record<string, unknown>;
}

/**
 * Resources returned by createTestSession that need cleanup.
 */
export interface TestSessionContext {
	session: AgentSession;
	sessionManager: SessionManager;
	tempDir: string;
	cleanup: () => void;
}

export interface CreateTestExtensionsResultInput {
	factory: ExtensionFactory;
	path?: string;
}

export async function createTestExtensionsResult(
	inputs: Array<ExtensionFactory | CreateTestExtensionsResultInput>,
	cwd = process.cwd(),
): Promise<LoadExtensionsResult> {
	const runtime = createExtensionRuntime();
	const eventBus = createEventBus();
	const extensions: Extension[] = [];

	for (const [index, input] of inputs.entries()) {
		const factory = typeof input === "function" ? input : input.factory;
		const extensionPath =
			typeof input === "function" ? `<inline:${index + 1}>` : (input.path ?? `<inline:${index + 1}>`);
		extensions.push(await loadExtensionFromFactory(factory, cwd, eventBus, runtime, extensionPath));
	}

	return {
		extensions,
		errors: [],
		runtime,
	};
}

export interface CreateTestResourceLoaderOptions {
	extensionsResult?: LoadExtensionsResult;
}

export function createTestResourceLoader(options: CreateTestResourceLoaderOptions = {}): ResourceLoader {
	const extensionsResult = options.extensionsResult ?? {
		extensions: [],
		errors: [],
		runtime: createExtensionRuntime(),
	};

	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

/**
 * Create an AgentSession for testing with proper setup and cleanup.
 * Use this for e2e tests that need real LLM calls.
 */
export function createTestSession(options: TestSessionOptions = {}): TestSessionContext {
	const tempDir = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		getApiKey: () => API_KEY,
		initialState: {
			model,
			systemPrompt: options.systemPrompt ?? "You are a helpful assistant. Be extremely concise.",
			tools: createCodingTools(process.cwd()),
		},
	});

	const sessionManager = options.inMemory ? SessionManager.inMemory() : SessionManager.create(tempDir);
	const settingsManager = SettingsManager.create(tempDir, tempDir);

	if (options.settingsOverrides) {
		settingsManager.applyOverrides(options.settingsOverrides);
	}

	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, tempDir);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry,
		resourceLoader: createTestResourceLoader(),
	});

	// Must subscribe to enable session persistence
	session.subscribe(() => {});

	const cleanup = () => {
		session.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	};

	return { session, sessionManager, tempDir, cleanup };
}

/**
 * Build a session tree for testing using SessionManager.
 * Returns the IDs of all created entries.
 *
 * Example tree structure:
 * ```
 * u1 -> a1 -> u2 -> a2
 *          -> u3 -> a3  (branch from a1)
 * u4 -> a4              (another root)
 * ```
 */
export function buildTestTree(
	session: SessionManager,
	structure: {
		messages: Array<{ role: "user" | "assistant"; text: string; branchFrom?: string }>;
	},
): Map<string, string> {
	const ids = new Map<string, string>();

	for (const msg of structure.messages) {
		if (msg.branchFrom) {
			const branchFromId = ids.get(msg.branchFrom);
			if (!branchFromId) {
				throw new Error(`Cannot branch from unknown entry: ${msg.branchFrom}`);
			}
			session.branch(branchFromId);
		}

		const id =
			msg.role === "user" ? session.appendMessage(userMsg(msg.text)) : session.appendMessage(assistantMsg(msg.text));

		ids.set(msg.text, id);
	}

	return ids;
}
