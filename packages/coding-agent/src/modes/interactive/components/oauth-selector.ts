import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	TruncatedText,
} from "@earendil-works/pi-tui";
import type { AuthStatus, AuthStorage } from "../../../core/auth-storage.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export type AuthSelectorProvider = {
	id: string;
	name: string;
	authType: "oauth" | "api_key";
	credentialsProviderId?: string;
	parentProviderId?: string;
	loginOptionLabel?: string;
};

/**
 * Component that renders an auth provider selector
 */
export class OAuthSelectorComponent extends Container implements Focusable {
	private titleContainer: Container;
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
	private authStorage: AuthStorage;
	private getAuthStatus: (providerId: string) => AuthStatus;
	private onSelectCallback: (providerId: string) => void;
	private onCancelCallback: () => void;
	private loginMethodParentProviderId: string | null = null;

	constructor(
		mode: "login" | "logout",
		authStorage: AuthStorage,
		providers: AuthSelectorProvider[],
		onSelect: (providerId: string) => void,
		onCancel: () => void,
		getAuthStatus?: (providerId: string) => AuthStatus,
	) {
		super();

		this.mode = mode;
		this.authStorage = authStorage;
		this.getAuthStatus = getAuthStatus ?? ((providerId) => this.authStorage.getAuthStatus(providerId));
		this.allProviders = providers;
		this.filteredProviders = providers;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add title
		this.titleContainer = new Container();
		this.addChild(this.titleContainer);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.searchInput.onSubmit = () => {
			this.selectCurrentProvider();
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
		this.filterProviders("");
	}

	private getParentProvider(): AuthSelectorProvider | undefined {
		if (!this.loginMethodParentProviderId) return undefined;
		return this.allProviders.find((provider) => provider.id === this.loginMethodParentProviderId);
	}

	private getSelectableProviders(): AuthSelectorProvider[] {
		if (this.mode !== "login" || !this.loginMethodParentProviderId) {
			return this.allProviders.filter((provider) => !provider.parentProviderId);
		}

		const parentProvider = this.getParentProvider();
		if (!parentProvider) {
			return this.allProviders.filter((provider) => !provider.parentProviderId);
		}

		const alternateProviders = this.allProviders.filter(
			(provider) => provider.parentProviderId === this.loginMethodParentProviderId,
		);
		return [parentProvider, ...alternateProviders];
	}

	private filterProviders(query: string): void {
		const selectableProviders = this.getSelectableProviders();
		this.filteredProviders = query
			? fuzzyFilter(
					selectableProviders,
					query,
					(provider) => `${provider.name} ${provider.id} ${provider.authType} ${provider.loginOptionLabel ?? ""}`,
				)
			: selectableProviders;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.filteredProviders.length - 1)));
		this.updateList();
	}

	private getTitle(): string {
		if (this.mode === "logout") {
			return "Select provider to logout:";
		}

		const parentProvider = this.getParentProvider();
		if (parentProvider) {
			return `Select login method for ${parentProvider.name}:`;
		}

		return "Select provider to configure:";
	}

	private getProviderLabel(provider: AuthSelectorProvider): string {
		if (this.mode === "login" && this.loginMethodParentProviderId) {
			return provider.loginOptionLabel ?? provider.name;
		}
		return provider.name;
	}

	private updateList(): void {
		this.titleContainer.clear();
		this.titleContainer.addChild(new TruncatedText(theme.fg("accent", theme.bold(this.getTitle())), 1, 0));
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
			const statusIndicator = this.loginMethodParentProviderId ? "" : this.formatStatusIndicator(provider);
			const label = this.getProviderLabel(provider);

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", "→ ");
				const text = theme.fg("accent", label);
				line = prefix + text + statusIndicator;
			} else {
				const text = `  ${theme.fg("text", label)}`;
				line = text + statusIndicator;
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
		const credential = this.authStorage.get(provider.id);
		if (credential?.type === provider.authType) return theme.fg("success", " ✓ configured");
		if (credential) {
			const label = credential.type === "oauth" ? "subscription configured" : "API key configured";
			return theme.fg("muted", " • ") + theme.fg("warning", label);
		}
		if (provider.authType !== "api_key") return theme.fg("muted", " • unconfigured");

		const status = this.getAuthStatus(provider.id);
		switch (status.source) {
			case "environment":
				return theme.fg("success", ` ✓ env: ${status.label ?? "API key"}`);
			case "runtime":
				return theme.fg("success", " ✓ runtime API key");
			case "fallback":
				return theme.fg("success", " ✓ custom API key");
			case "models_json_key":
				return theme.fg("success", " ✓ key in models.json");
			case "models_json_command":
				return theme.fg("success", " ✓ command in models.json");
			default:
				return theme.fg("muted", " • unconfigured");
		}
	}

	private openLoginMethodSelector(provider: AuthSelectorProvider): void {
		this.loginMethodParentProviderId = provider.id;
		this.selectedIndex = 0;
		this.filterProviders(this.searchInput.getValue());
	}

	private closeLoginMethodSelector(): boolean {
		if (!this.loginMethodParentProviderId) {
			return false;
		}

		this.loginMethodParentProviderId = null;
		this.selectedIndex = 0;
		this.filterProviders(this.searchInput.getValue());
		return true;
	}

	private selectCurrentProvider(): void {
		const selectedProvider = this.filteredProviders[this.selectedIndex];
		if (!selectedProvider) return;

		const hasAlternateLoginMethods =
			this.mode === "login" &&
			!this.loginMethodParentProviderId &&
			this.allProviders.some((provider) => provider.parentProviderId === selectedProvider.id);

		if (hasAlternateLoginMethods) {
			this.openLoginMethodSelector(selectedProvider);
			return;
		}

		this.onSelectCallback(selectedProvider.id);
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
			this.selectCurrentProvider();
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (!this.closeLoginMethodSelector()) {
				this.onCancelCallback();
			}
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterProviders(this.searchInput.getValue());
		}
	}
}
