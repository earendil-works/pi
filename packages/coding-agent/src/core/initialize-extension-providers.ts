import type { LoadExtensionsResult } from "./extensions/index.ts";
import type { ModelRuntime } from "./model-runtime.ts";

export interface ProviderInitializationDiagnostic {
	type: "warning" | "error";
	message: string;
}

/** Register catalogs before CLI/SDK initial model selection, including dynamic local providers. */
export async function initializeExtensionProviders(
	extensions: LoadExtensionsResult,
	modelRuntime: ModelRuntime,
	signal?: AbortSignal,
): Promise<ProviderInitializationDiagnostic[]> {
	const diagnostics: ProviderInitializationDiagnostic[] = [];
	for (const { name, config, extensionPath } of extensions.runtime.pendingProviderRegistrations) {
		try {
			modelRuntime.registerProvider(name, config);
		} catch (error) {
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}
	extensions.runtime.pendingProviderRegistrations = [];
	for (const { provider, extensionPath } of extensions.runtime.pendingNativeProviderRegistrations) {
		try {
			modelRuntime.registerNativeProvider(provider);
		} catch (error) {
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}
	extensions.runtime.pendingNativeProviderRegistrations = [];
	await modelRuntime.refresh({ allowNetwork: false, signal });
	// Cached catalogs are immediately usable. Empty dynamic catalogs need one
	// bounded discovery pass; unconfigured providers and offline runs do no I/O.
	if (process.env.PI_OFFLINE === undefined) {
		const providers = modelRuntime.getRegisteredProviderIds().filter((id) => {
			const provider = modelRuntime.getRegisteredNativeProvider(id);
			return provider?.refreshModels && provider.getModels().length === 0 && modelRuntime.hasConfiguredAuth(id);
		});
		if (providers.length) {
			const result = await modelRuntime.refresh({
				providers,
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
			});
			for (const [id, error] of result.errors)
				diagnostics.push({ type: "warning", message: `${id}: ${error.message}` });
			if (result.aborted)
				diagnostics.push({ type: "warning", message: "Model discovery was cancelled or timed out." });
		}
	}
	return diagnostics;
}
