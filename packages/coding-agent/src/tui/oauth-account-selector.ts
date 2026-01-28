import { Container, Spacer, TruncatedText } from "@kennyfrc/mu-tui";
import type { OAuthAccountEntry } from "../oauth/index.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

type AccountSelection = { type: "account"; accountId: string } | { type: "add" };

type AccountListItem = { type: "account"; account: OAuthAccountEntry; isActive: boolean } | { type: "add" };

function formatAccountId(id: string): string {
	if (id.length <= 12) return id;
	return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function formatAccountLabel(account: OAuthAccountEntry): string {
	const label = account.label ?? account.credentials.email ?? account.id;
	const suffix = account.id !== label ? ` (${formatAccountId(account.id)})` : "";
	return `${label}${suffix}`;
}

/**
 * Component that renders an OAuth account selector
 */
export class OAuthAccountSelectorComponent extends Container {
	private listContainer: Container;
	private selectedIndex = 0;
	private items: AccountListItem[] = [];
	private mode: "login" | "logout";
	private onSelectCallback: (selection: AccountSelection) => void;
	private onCancelCallback: () => void;

	constructor(
		mode: "login" | "logout",
		accounts: OAuthAccountEntry[],
		activeAccountId: string | null,
		onSelect: (selection: AccountSelection) => void,
		onCancel: () => void,
	) {
		super();

		this.mode = mode;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.items = accounts.map((account) => ({
			type: "account",
			account,
			isActive: account.id === activeAccountId,
		}));

		if (mode === "login") {
			this.items.push({ type: "add" });
		}

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add title
		const title = mode === "login" ? "Select account to use:" : "Select account to logout:";
		this.addChild(new TruncatedText(theme.bold(title)));
		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.items.length === 0) {
			const message =
				this.mode === "login" ? "No accounts available" : "No OAuth accounts available. Use /login first.";
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${message}`), 0, 0));
			return;
		}

		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;

			if (item.type === "add") {
				const label = "+ Add new account";
				const line = isSelected ? `${theme.fg("accent", "→ ")}${theme.fg("accent", label)}` : `  ${label}`;
				this.listContainer.addChild(new TruncatedText(line, 0, 0));
				continue;
			}

			const label = formatAccountLabel(item.account);
			const status = item.isActive ? theme.fg("success", " ✓ active") : "";
			const line = isSelected
				? `${theme.fg("accent", "→ ")}${theme.fg("accent", label)}${status}`
				: `  ${label}${status}`;
			this.listContainer.addChild(new TruncatedText(line, 0, 0));
		}
	}

	handleInput(keyData: string): void {
		if (keyData === "\x1b[A") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (keyData === "\x1b[B") {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (keyData === "\r") {
			const selected = this.items[this.selectedIndex];
			if (!selected) return;
			if (selected.type === "add") {
				this.onSelectCallback({ type: "add" });
				return;
			}
			this.onSelectCallback({ type: "account", accountId: selected.account.id });
		} else if (keyData === "\x1b") {
			this.onCancelCallback();
		}
	}
}
