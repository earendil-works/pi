import type { ApiKeyAuth, AuthCheck, OAuthAuth } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	TruncatedText,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export type AuthSelectorProvider = {
	id: string;
	name: string;
	authType: "oauth" | "api_key";
	method?: ApiKeyAuth | OAuthAuth;
	status?: AuthCheck;
};

export function formatAuthSelectorProviderType(authType: AuthSelectorProvider["authType"]): string {
	return authType === "oauth" ? "subscription" : "API key";
}

/**
 * Component that renders an auth provider selector
 */
export class OAuthSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable implementation - propagate to search input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private listContainer: Container;
	private allProviders: AuthSelectorProvider[];
	private filteredProviders: AuthSelectorProvider[];
	private selectedIndex: number = 0;
	private mode: "login" | "logout";
	private onSelectCallback: (providerId: string, authType: AuthSelectorProvider["authType"]) => void;
	private onCancelCallback: () => void;
	private showAuthTypeLabels: boolean;

	constructor(
		mode: "login" | "logout",
		providers: AuthSelectorProvider[],
		onSelect: (providerId: string, authType: AuthSelectorProvider["authType"]) => void,
		onCancel: () => void,
		initialSearchInput?: string,
	) {
		super();

		this.mode = mode;
		this.allProviders = providers;
		this.filteredProviders = providers;
		this.showAuthTypeLabels = new Set(providers.map((provider) => provider.authType)).size > 1;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add title
		const title = mode === "login" ? "Select provider to configure:" : "Select provider to logout:";
		this.addChild(new TruncatedText(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider.id, selectedProvider.authType);
			}
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Initial render
		this.filterProviders(initialSearchInput ?? "");
	}

	private filterProviders(query: string): void {
		this.filteredProviders = query
			? fuzzyFilter(
					this.allProviders,
					query,
					(provider) => `${provider.name} ${provider.id} ${provider.authType} ${provider.method?.name ?? ""}`,
				)
			: this.allProviders;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.filteredProviders.length - 1)));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = 8;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredProviders.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredProviders.length);

		for (let i = startIndex; i < endIndex; i++) {
			const provider = this.filteredProviders[i];
			if (!provider) continue;

			const isSelected = i === this.selectedIndex;

			const statusIndicator = this.formatStatusIndicator(provider);
			const authTypeLabel = this.showAuthTypeLabels
				? theme.fg("muted", ` [${formatAuthSelectorProviderType(provider.authType)}]`)
				: "";
			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", "→ ");
				const text = theme.fg("accent", provider.name);
				line = prefix + text + authTypeLabel + statusIndicator;
			} else {
				const text = `  ${theme.fg("text", provider.name)}`;
				line = text + authTypeLabel + statusIndicator;
			}

			this.listContainer.addChild(new TruncatedText(line, 1, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredProviders.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredProviders.length})`);
			this.listContainer.addChild(new TruncatedText(scrollInfo, 1, 0));
		}

		// Show "no providers" if empty
		if (this.filteredProviders.length === 0) {
			const message =
				this.allProviders.length === 0
					? this.mode === "login"
						? "No providers available"
						: "No providers logged in. Use /login first."
					: "No matching providers";
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${message}`), 1, 0));
		}
	}

	private formatStatusIndicator(provider: AuthSelectorProvider): string {
		if (!provider.status) return theme.fg("muted", " • unconfigured");
		if (provider.status.type !== provider.authType) {
			const label = provider.status.type === "oauth" ? "subscription configured" : "API key configured";
			return theme.fg("muted", " • ") + theme.fg("warning", label);
		}
		if (
			!provider.status.source ||
			provider.status.source === "OAuth" ||
			provider.status.source === "stored credential"
		) {
			return theme.fg("success", " ✓ configured");
		}
		const source = /^[A-Z][A-Z0-9_]*(?:, [A-Z][A-Z0-9_]*)*$/.test(provider.status.source)
			? `env: ${provider.status.source}`
			: provider.status.source;
		return theme.fg("success", ` ✓ ${source}`);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Up arrow
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredProviders.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		}
		// Down arrow
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredProviders.length === 0) return;
			this.selectedIndex = Math.min(this.filteredProviders.length - 1, this.selectedIndex + 1);
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider.id, selectedProvider.authType);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterProviders(this.searchInput.getValue());
		}
	}
}
