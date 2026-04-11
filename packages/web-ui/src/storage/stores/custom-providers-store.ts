import type { Model } from "@tculpepp/pi-ai";
import { Store } from "../store.js";
import type { StoreConfig } from "../types.js";

export type AutoDiscoveryProviderType = "ollama" | "llama.cpp" | "vllm" | "lmstudio";

export type CustomProviderType =
	| AutoDiscoveryProviderType // Auto-discovery - models fetched on-demand
	| "openai-completions" // Manual models - stored in provider.models
	| "openai-responses" // Manual models - stored in provider.models
	| "anthropic-messages"; // Manual models - stored in provider.models

export interface CustomProvider {
	id: string; // UUID
	name: string; // Display name, also used as Model.provider
	type: CustomProviderType;
	baseUrl: string;
	apiKey?: string; // Optional, applies to all models

	// For manual types ONLY - models stored directly on provider
	// Auto-discovery types: models fetched on-demand, never stored
	models?: Model<any>[];
}

/**
 * Store for custom LLM providers (auto-discovery servers + manual providers).
 */
export class CustomProvidersStore extends Store {
	getConfig(): StoreConfig {
		return {
			name: "custom-providers",
		};
	}

	async get(id: string): Promise<CustomProvider | null> {
		return this.getBackend().get("custom-providers", id);
	}

	async set(provider: CustomProvider): Promise<void> {
		await this.getBackend().set("custom-providers", provider.id, provider);
	}

	async delete(id: string): Promise<void> {
		await this.getBackend().delete("custom-providers", id);
	}

	async getAll(): Promise<CustomProvider[]> {
		const keys = await this.getBackend().keys("custom-providers");
		const providers: CustomProvider[] = [];
		for (const key of keys) {
			const provider = await this.get(key);
			if (provider) {
				providers.push(provider);
			}
		}
		return providers;
	}

	async has(id: string): Promise<boolean> {
		return this.getBackend().has("custom-providers", id);
	}
}
