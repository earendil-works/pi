import { i18n } from "@mariozechner/mini-lit";
import { Dialog, DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { Label } from "@mariozechner/mini-lit/dist/Label.js";
import { Switch } from "@mariozechner/mini-lit/dist/Switch.js";
import { getProviders } from "@mariozechner/pi-ai";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "../components/ProviderKeyInput.js";
import { getAppStorage } from "../storage/app-storage.js";

// Base class for settings tabs
export abstract class SettingsTab extends LitElement {
	abstract getTabName(): string;

	protected createRenderRoot() {
		return this;
	}
}

// API Keys Tab
@customElement("api-keys-tab")
export class ApiKeysTab extends SettingsTab {
	getTabName(): string {
		return i18n("API Keys");
	}

	render(): TemplateResult {
		const providers = getProviders();

		return html`
			<div class="flex flex-col gap-6">
				<p class="text-sm text-muted-foreground">
					${i18n("Configure API keys for LLM providers. Keys are stored locally in your browser.")}
				</p>
				${providers.map((provider) => html`<provider-key-input .provider=${provider}></provider-key-input>`)}
			</div>
		`;
	}
}

// Proxy Tab
@customElement("proxy-tab")
export class ProxyTab extends SettingsTab {
	@state() private proxyEnabled = false;
	@state() private proxyUrl = "http://localhost:3001";

	override async connectedCallback() {
		super.connectedCallback();
		// Load proxy settings when tab is connected
		try {
			const storage = getAppStorage();
			const enabled = await storage.settings.get<boolean>("proxy.enabled");
			const url = await storage.settings.get<string>("proxy.url");

			if (enabled !== null) this.proxyEnabled = enabled;
			if (url !== null) this.proxyUrl = url;
		} catch (error) {
			console.error("Failed to load proxy settings:", error);
		}
	}

	private async saveProxySettings() {
		try {
			const storage = getAppStorage();
			await storage.settings.set("proxy.enabled", this.proxyEnabled);
			await storage.settings.set("proxy.url", this.proxyUrl);
		} catch (error) {
			console.error("Failed to save proxy settings:", error);
		}
	}

	getTabName(): string {
		return i18n("Proxy");
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-4">
				<p class="text-sm text-muted-foreground">
					${i18n("Allows browser-based apps to bypass CORS restrictions when calling LLM providers. Required for Z-AI and Anthropic with OAuth token.")}
				</p>

				<div class="flex items-center justify-between">
					<span class="text-sm font-medium text-foreground">${i18n("Use CORS Proxy")}</span>
					${Switch({
						checked: this.proxyEnabled,
						onChange: (checked: boolean) => {
							this.proxyEnabled = checked;
							this.saveProxySettings();
						},
					})}
				</div>

				<div class="space-y-2">
					${Label({ children: i18n("Proxy URL") })}
					${Input({
						type: "text",
						value: this.proxyUrl,
						disabled: !this.proxyEnabled,
						onInput: (e) => {
							this.proxyUrl = (e.target as HTMLInputElement).value;
						},
						onChange: () => this.saveProxySettings(),
					})}
					<p class="text-xs text-muted-foreground">
						${i18n("Format: The proxy must accept requests as <proxy-url>/?url=<target-url>")}
					</p>
				</div>
			</div>
		`;
	}
}

@customElement("settings-dialog")
export class SettingsDialog extends LitElement {
	@property({ type: Array, attribute: false }) tabs: SettingsTab[] = [];
	@state() private isOpen = false;
	@state() private activeTabIndex = 0;

	protected createRenderRoot() {
		return this;
	}

	private onCloseCallback?: () => void;

	static async open(tabs: SettingsTab[], onClose?: () => void) {
		const dialog = new SettingsDialog();
		dialog.tabs = tabs;
		dialog.onCloseCallback = onClose;
		dialog.isOpen = true;
		document.body.appendChild(dialog);
	}

	private setActiveTab(index: number) {
		this.activeTabIndex = index;
	}

	private renderSidebarItem(tab: SettingsTab, index: number): TemplateResult {
		const isActive = this.activeTabIndex === index;
		return html`
			<button
				class="w-full text-left px-4 py-3 rounded-md transition-colors ${
					isActive
						? "bg-secondary text-foreground font-medium"
						: "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
				}"
				@click=${() => this.setActiveTab(index)}
			>
				${tab.getTabName()}
			</button>
		`;
	}

	private renderMobileTab(tab: SettingsTab, index: number): TemplateResult {
		const isActive = this.activeTabIndex === index;
		return html`
			<button
				class="px-3 py-2 text-sm font-medium transition-colors ${
					isActive ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"
				}"
				@click=${() => this.setActiveTab(index)}
			>
				${tab.getTabName()}
			</button>
		`;
	}

	render() {
		if (this.tabs.length === 0) {
			return html``;
		}

		return Dialog({
			isOpen: this.isOpen,
			onClose: () => {
				this.isOpen = false;
				this.remove();
				this.onCloseCallback?.();
			},
			width: "min(1000px, 90vw)",
			height: "min(800px, 90vh)",
			backdropClassName: "bg-black/50 backdrop-blur-sm",
			children: html`
				${DialogContent({
					className: "h-full p-6",
					children: html`
						<div class="flex flex-col h-full overflow-hidden">
							<!-- Header -->
							<div class="pb-4 flex-shrink-0">${DialogHeader({ title: i18n("Settings") })}</div>

							<!-- Mobile Tabs -->
							<div class="md:hidden flex flex-shrink-0 pb-4">
								${this.tabs.map((tab, index) => this.renderMobileTab(tab, index))}
							</div>

							<!-- Layout -->
							<div class="flex flex-1 overflow-hidden">
								<!-- Sidebar (desktop only) -->
								<div class="hidden md:block w-64 flex-shrink-0 space-y-1">
									${this.tabs.map((tab, index) => this.renderSidebarItem(tab, index))}
								</div>

								<!-- Content -->
								<div class="flex-1 overflow-y-auto md:pl-6">
									${this.tabs.map(
										(tab, index) =>
											html`<div style="display: ${this.activeTabIndex === index ? "block" : "none"}">${tab}</div>`,
									)}
								</div>
							</div>
						</div>
					`,
				})}
			`,
		});
	}
}
