import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceLoader } from "../src/core/resource-loader.js";

const mockState = vi.hoisted(() => ({
	defaultLoaderReloads: 0,
	defaultLoaderInstances: 0,
	registerProvider: vi.fn(),
	createAgentSession: vi.fn(
		async (options: { sessionManager?: unknown; resourceLoader: unknown }) =>
			({
				session: {
					sessionManager: options.sessionManager ?? ({ id: "session-manager" } as unknown),
					dispose: vi.fn(),
					extensionRunner: undefined,
				},
				modelFallbackMessage: undefined,
			}) as const,
	),
}));

vi.mock("../src/core/resource-loader.js", () => ({
	DefaultResourceLoader: class {
		constructor(_options: unknown) {
			mockState.defaultLoaderInstances += 1;
		}

		async reload(): Promise<void> {
			mockState.defaultLoaderReloads += 1;
		}

		getExtensions() {
			return {
				extensions: [],
				errors: [],
				runtime: {
					pendingProviderRegistrations: [],
					flagValues: new Map(),
				},
			};
		}
	},
}));

vi.mock("../src/core/model-registry.js", () => ({
	ModelRegistry: {
		create: () => ({
			registerProvider: mockState.registerProvider,
		}),
	},
}));

vi.mock("../src/core/settings-manager.js", () => ({
	SettingsManager: {
		create: () => ({ id: "settings-manager" }),
	},
}));

vi.mock("../src/core/auth-storage.js", () => ({
	AuthStorage: {
		create: () => ({ id: "auth-storage" }),
	},
}));

vi.mock("../src/core/sdk.js", () => ({
	createAgentSession: mockState.createAgentSession,
}));

import { createAgentSessionRuntime } from "../src/core/agent-session-runtime.js";

describe("createAgentSessionRuntime resource loader lifecycle", () => {
	beforeEach(() => {
		mockState.defaultLoaderReloads = 0;
		mockState.defaultLoaderInstances = 0;
		mockState.registerProvider.mockReset();
		mockState.createAgentSession.mockClear();
	});

	it("uses a provided preloaded resource loader without reloading it", async () => {
		const providedReload = vi.fn(async () => {});
		const providedLoader = {
			reload: providedReload,
			getExtensions: () => ({
				extensions: [],
				errors: [],
				runtime: {
					pendingProviderRegistrations: [],
					flagValues: new Map(),
				},
			}),
			getSkills: () => ({
				skills: [],
				diagnostics: [],
			}),
			getPrompts: () => ({
				prompts: [],
				diagnostics: [],
			}),
			getThemes: () => ({
				themes: [],
				diagnostics: [],
			}),
			getAgentsFiles: () => ({
				agentsFiles: [],
			}),
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			extendResources: () => {},
		} as unknown as ResourceLoader;

		await createAgentSessionRuntime(
			{
				resourceLoader: {
					noExtensions: true,
				},
			},
			{
				cwd: "/tmp/runtime-test",
				resourceLoader: providedLoader,
			},
		);

		expect(providedReload).not.toHaveBeenCalled();
		expect(mockState.defaultLoaderReloads).toBe(0);
		expect(mockState.defaultLoaderInstances).toBe(0);
	});

	it("creates and reloads a default resource loader when no preloaded loader is provided", async () => {
		await createAgentSessionRuntime(
			{
				resourceLoader: {
					noExtensions: true,
				},
			},
			{
				cwd: "/tmp/runtime-test",
			},
		);

		expect(mockState.defaultLoaderInstances).toBe(1);
		expect(mockState.defaultLoaderReloads).toBe(1);
	});
});
