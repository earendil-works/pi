import type { ExtensionRuntime } from "./types.js";

/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 */
export function createExtensionRuntime(): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};

	const runtime: ExtensionRuntime = {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		setActiveTools: notInitialized,
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		registerProvider: (name, config, extensionPath = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
		},
		unregisterProvider: (name) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
		},
	};

	return runtime;
}
