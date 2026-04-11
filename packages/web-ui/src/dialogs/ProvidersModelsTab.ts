import { i18n } from "@mariozechner/mini-lit";
import { Select } from "@mariozechner/mini-lit/dist/Select.js";
import { getProviders } from "@tculpepp/pi-ai";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import "../components/CustomProviderCard.js";
import "../components/ProviderKeyInput.js";
import { getAppStorage } from "../storage/app-storage.js";
import type {
	AutoDiscoveryProviderType,
	CustomProvider,
	CustomProviderType,
} from "../storage/stores/custom-providers-store.js";
import { discoverModels } from "../utils/model-discovery.js";
import { CustomProviderDialog } from "./CustomProviderDialog.js";
import { SettingsTab } from "./SettingsDialog.js";

@customElement("providers-models-tab")
export class ProvidersModelsTab extends SettingsTab {
	@state() private customProviders: CustomProvider[] = [];
	@state() private providerStatus: Map<
		string,
		{ modelCount: number; status: "connected" | "disconnected" | "checking" }
	> = new Map();

	override async connectedCallback() {
		super.connectedCallback();
		await this.loadCustomProviders();
	}

	private async loadCustomProviders() {
		try {
			const storage = getAppStorage();
			this.customProviders = await storage.customProviders.getAll();

			// Check status for auto-discovery providers
			for (const provider of this.customProviders) {
				const isAutoDiscovery =
					provider.type === "ollama" ||
					provider.type === "llama.cpp" ||
					provider.type === "vllm" ||
					provider.type === "lmstudio";
				if (isAutoDiscovery) {
					this.checkProviderStatus(provider);
				}
			}
		} catch (error) {
			console.error("Failed to load custom providers:", error);
		}
	}

	getTabName(): string {
		return "Providers & Models";
	}

	private async checkProviderStatus(provider: CustomProvider) {
		this.providerStatus.set(provider.id, { modelCount: 0, status: "checking" });
		this.requestUpdate();

		try {
			const models = await discoverModels(
				provider.type as AutoDiscoveryProviderType,
				provider.baseUrl,
				provider.apiKey,
			);

			this.providerStatus.set(provider.id, { modelCount: models.length, status: "connected" });
		} catch (_error) {
			this.providerStatus.set(provider.id, { modelCount: 0, status: "disconnected" });
		}
		this.requestUpdate();
	}

	private renderKnownProviders(): TemplateResult {
		const providers = getProviders();

		return html`
			<div class="flex flex-col gap-6">
				<div>
					<h3 class="text-sm font-semibold text-foreground mb-2">Cloud Providers</h3>
					<p class="text-sm text-muted-foreground mb-4">
						Cloud LLM providers with predefined models. API keys are stored locally in your browser.
					</p>
				</div>
				<div class="flex flex-col gap-6">
					${providers.map((provider) => html` <provider-key-input .provider=${provider}></provider-key-input> `)}
				</div>
			</div>
		`;
	}

	private renderCustomProviders(): TemplateResult {
		const isAutoDiscovery = (type: string) =>
			type === "ollama" || type === "llama.cpp" || type === "vllm" || type === "lmstudio";

		return html`
			<div class="flex flex-col gap-6">
				<div class="flex items-center justify-between">
					<div>
						<h3 class="text-sm font-semibold text-foreground mb-2">Custom Providers</h3>
						<p class="text-sm text-muted-foreground">
							User-configured servers with auto-discovered or manually defined models.
						</p>
					</div>
					${Select({
						placeholder: i18n("Add Provider"),
						options: [
							{ value: "ollama", label: "Ollama" },
							{ value: "llama.cpp", label: "llama.cpp" },
							{ value: "vllm", label: "vLLM" },
							{ value: "lmstudio", label: "LM Studio" },
							{ value: "openai-completions", label: i18n("OpenAI Completions Compatible") },
							{ value: "openai-responses", label: i18n("OpenAI Responses Compatible") },
							{ value: "anthropic-messages", label: i18n("Anthropic Messages Compatible") },
						],
						onChange: (value: string) => this.addCustomProvider(value as CustomProviderType),
						variant: "outline",
						size: "sm",
					})}
				</div>

				${
					this.customProviders.length === 0
						? html`
							<div class="text-sm text-muted-foreground text-center py-8">
								No custom providers configured. Click 'Add Provider' to get started.
							</div>
						`
						: html`
							<div class="flex flex-col gap-4">
								${this.customProviders.map(
									(provider) => html`
										<custom-provider-card
											.provider=${provider}
											.isAutoDiscovery=${isAutoDiscovery(provider.type)}
											.status=${this.providerStatus.get(provider.id)}
											.onRefresh=${(p: CustomProvider) => this.refreshProvider(p)}
											.onEdit=${(p: CustomProvider) => this.editProvider(p)}
											.onDelete=${(p: CustomProvider) => this.deleteProvider(p)}
										></custom-provider-card>
									`,
								)}
							</div>
						`
				}
			</div>
		`;
	}

	private async addCustomProvider(type: CustomProviderType) {
		await CustomProviderDialog.open(undefined, type, async () => {
			await this.loadCustomProviders();
			this.requestUpdate();
		});
	}

	private async editProvider(provider: CustomProvider) {
		await CustomProviderDialog.open(provider, undefined, async () => {
			await this.loadCustomProviders();
			this.requestUpdate();
		});
	}

	private async refreshProvider(provider: CustomProvider) {
		this.providerStatus.set(provider.id, { modelCount: 0, status: "checking" });
		this.requestUpdate();

		try {
			const models = await discoverModels(
				provider.type as AutoDiscoveryProviderType,
				provider.baseUrl,
				provider.apiKey,
			);

			this.providerStatus.set(provider.id, { modelCount: models.length, status: "connected" });
			this.requestUpdate();

			console.log(`Refreshed ${models.length} models from ${provider.name}`);
		} catch (error) {
			this.providerStatus.set(provider.id, { modelCount: 0, status: "disconnected" });
			this.requestUpdate();

			console.error(`Failed to refresh provider ${provider.name}:`, error);
			alert(`Failed to refresh provider: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async deleteProvider(provider: CustomProvider) {
		if (!confirm("Are you sure you want to delete this provider?")) {
			return;
		}

		try {
			const storage = getAppStorage();
			await storage.customProviders.delete(provider.id);
			await this.loadCustomProviders();
			this.requestUpdate();
		} catch (error) {
			console.error("Failed to delete provider:", error);
		}
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-8">
				${this.renderKnownProviders()}
				<div class="border-t border-border"></div>
				${this.renderCustomProviders()}
			</div>
		`;
	}
}
