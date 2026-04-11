import { i18n } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { Label } from "@mariozechner/mini-lit/dist/Label.js";
import { Select } from "@mariozechner/mini-lit/dist/Select.js";
import type { Model } from "@tculpepp/spi-ai";
import { html, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { getAppStorage } from "../storage/app-storage.js";
import type { CustomProvider, CustomProviderType } from "../storage/stores/custom-providers-store.js";
import { discoverModels } from "../utils/model-discovery.js";

export class CustomProviderDialog extends DialogBase {
	private provider?: CustomProvider;
	private initialType?: CustomProviderType;
	private onSaveCallback?: () => void;

	@state() private name = "";
	@state() private type: CustomProviderType = "openai-completions";
	@state() private baseUrl = "";
	@state() private apiKey = "";
	@state() private testing = false;
	@state() private testError = "";
	@state() private discoveredModels: Model<any>[] = [];

	protected modalWidth = "min(800px, 90vw)";
	protected modalHeight = "min(700px, 90vh)";

	static async open(
		provider: CustomProvider | undefined,
		initialType: CustomProviderType | undefined,
		onSave?: () => void,
	) {
		const dialog = new CustomProviderDialog();
		dialog.provider = provider;
		dialog.initialType = initialType;
		dialog.onSaveCallback = onSave;
		document.body.appendChild(dialog);
		dialog.initializeFromProvider();
		dialog.open();
		dialog.requestUpdate();
	}

	private initializeFromProvider() {
		if (this.provider) {
			this.name = this.provider.name;
			this.type = this.provider.type;
			this.baseUrl = this.provider.baseUrl;
			this.apiKey = this.provider.apiKey || "";
			this.discoveredModels = this.provider.models || [];
		} else {
			this.name = "";
			this.type = this.initialType || "openai-completions";
			this.baseUrl = "";
			this.updateDefaultBaseUrl();
			this.apiKey = "";
			this.discoveredModels = [];
		}
		this.testError = "";
		this.testing = false;
	}

	private updateDefaultBaseUrl() {
		if (this.baseUrl) return;

		const defaults: Record<string, string> = {
			ollama: "http://localhost:11434",
			"llama.cpp": "http://localhost:8080",
			vllm: "http://localhost:8000",
			lmstudio: "http://localhost:1234",
			"openai-completions": "",
			"openai-responses": "",
			"anthropic-messages": "",
		};

		this.baseUrl = defaults[this.type] || "";
	}

	private isAutoDiscoveryType(): boolean {
		return this.type === "ollama" || this.type === "llama.cpp" || this.type === "vllm" || this.type === "lmstudio";
	}

	private async testConnection() {
		if (!this.isAutoDiscoveryType()) return;

		this.testing = true;
		this.testError = "";
		this.discoveredModels = [];

		try {
			const models = await discoverModels(
				this.type as "ollama" | "llama.cpp" | "vllm" | "lmstudio",
				this.baseUrl,
				this.apiKey || undefined,
			);

			this.discoveredModels = models.map((model) => ({
				...model,
				provider: this.name || this.type,
			}));

			this.testError = "";
		} catch (error) {
			this.testError = error instanceof Error ? error.message : String(error);
			this.discoveredModels = [];
		} finally {
			this.testing = false;
			this.requestUpdate();
		}
	}

	private async save() {
		if (!this.name || !this.baseUrl) {
			alert(i18n("Please fill in all required fields"));
			return;
		}

		try {
			const storage = getAppStorage();

			const provider: CustomProvider = {
				id: this.provider?.id || crypto.randomUUID(),
				name: this.name,
				type: this.type,
				baseUrl: this.baseUrl,
				apiKey: this.apiKey || undefined,
				models: this.isAutoDiscoveryType() ? undefined : this.provider?.models || [],
			};

			await storage.customProviders.set(provider);

			if (this.onSaveCallback) {
				this.onSaveCallback();
			}
			this.close();
		} catch (error) {
			console.error("Failed to save provider:", error);
			alert(i18n("Failed to save provider"));
		}
	}

	protected override renderContent(): TemplateResult {
		const providerTypes = [
			{ value: "ollama", label: "Ollama (auto-discovery)" },
			{ value: "llama.cpp", label: "llama.cpp (auto-discovery)" },
			{ value: "vllm", label: "vLLM (auto-discovery)" },
			{ value: "lmstudio", label: "LM Studio (auto-discovery)" },
			{ value: "openai-completions", label: "OpenAI Completions Compatible" },
			{ value: "openai-responses", label: "OpenAI Responses Compatible" },
			{ value: "anthropic-messages", label: "Anthropic Messages Compatible" },
		];

		return html`
			<div class="flex flex-col h-full overflow-hidden">
				<div class="p-6 flex-shrink-0 border-b border-border">
					<h2 class="text-lg font-semibold text-foreground">
						${this.provider ? i18n("Edit Provider") : i18n("Add Provider")}
					</h2>
				</div>

				<div class="flex-1 overflow-y-auto p-6">
					<div class="flex flex-col gap-4">
						<div class="flex flex-col gap-2">
							${Label({ htmlFor: "provider-name", children: i18n("Provider Name") })}
							${Input({
								value: this.name,
								placeholder: i18n("e.g., My Ollama Server"),
								onInput: (e: Event) => {
									this.name = (e.target as HTMLInputElement).value;
									this.requestUpdate();
								},
							})}
						</div>

						<div class="flex flex-col gap-2">
							${Label({ htmlFor: "provider-type", children: i18n("Provider Type") })}
							${Select({
								value: this.type,
								options: providerTypes.map((pt) => ({
									value: pt.value,
									label: pt.label,
								})),
								onChange: (value: string) => {
									this.type = value as CustomProviderType;
									this.baseUrl = "";
									this.updateDefaultBaseUrl();
									this.requestUpdate();
								},
								width: "100%",
							})}
						</div>

						<div class="flex flex-col gap-2">
							${Label({ htmlFor: "base-url", children: i18n("Base URL") })}
							${Input({
								value: this.baseUrl,
								placeholder: i18n("e.g., http://localhost:11434"),
								onInput: (e: Event) => {
									this.baseUrl = (e.target as HTMLInputElement).value;
									this.requestUpdate();
								},
							})}
						</div>

						<div class="flex flex-col gap-2">
							${Label({ htmlFor: "api-key", children: i18n("API Key (Optional)") })}
							${Input({
								type: "password",
								value: this.apiKey,
								placeholder: i18n("Leave empty if not required"),
								onInput: (e: Event) => {
									this.apiKey = (e.target as HTMLInputElement).value;
									this.requestUpdate();
								},
							})}
						</div>

						${
							this.isAutoDiscoveryType()
								? html`
									<div class="flex flex-col gap-2">
										${Button({
											onClick: () => this.testConnection(),
											variant: "outline",
											disabled: this.testing || !this.baseUrl,
											children: this.testing ? i18n("Testing...") : i18n("Test Connection"),
										})}
										${this.testError ? html` <div class="text-sm text-destructive">${this.testError}</div> ` : ""}
										${
											this.discoveredModels.length > 0
												? html`
													<div class="text-sm text-muted-foreground">
														${i18n("Discovered")} ${this.discoveredModels.length} ${i18n("models")}:
														<ul class="list-disc list-inside mt-2">
															${this.discoveredModels.slice(0, 5).map((model) => html`<li>${model.name}</li>`)}
															${
																this.discoveredModels.length > 5
																	? html`<li>...${i18n("and")} ${this.discoveredModels.length - 5} ${i18n("more")}</li>`
																	: ""
															}
														</ul>
													</div>
												`
												: ""
										}
									</div>
								`
								: html` <div class="text-sm text-muted-foreground">
									${i18n("For manual provider types, add models after saving the provider.")}
								</div>`
						}
					</div>
				</div>

				<div class="p-6 flex-shrink-0 border-t border-border flex justify-end gap-2">
					${Button({
						onClick: () => this.close(),
						variant: "ghost",
						children: i18n("Cancel"),
					})}
					${Button({
						onClick: () => this.save(),
						variant: "default",
						disabled: !this.name || !this.baseUrl,
						children: i18n("Save"),
					})}
				</div>
			</div>
		`;
	}
}

customElements.define("custom-provider-dialog", CustomProviderDialog);
