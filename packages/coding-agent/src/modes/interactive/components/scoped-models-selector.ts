import type { Api, Model } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { getModelSearchText } from "../model-search.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyText } from "./keybinding-hints.ts";

// EnabledIds: null = all enabled (no filter), string[] = explicit ordered list
type EnabledIds = string[] | null;

function isEnabled(enabledIds: EnabledIds, id: string): boolean {
	return enabledIds === null || enabledIds.includes(id);
}

function toggle(enabledIds: EnabledIds, id: string): EnabledIds {
	if (enabledIds === null) return [id]; // First toggle: start with only this one
	const index = enabledIds.indexOf(id);
	if (index >= 0) return [...enabledIds.slice(0, index), ...enabledIds.slice(index + 1)];
	return [...enabledIds, id];
}

function enableAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (enabledIds === null) return null; // Already all enabled
	const targets = targetIds ?? allIds;
	const result = [...enabledIds];
	for (const id of targets) {
		if (!result.includes(id)) result.push(id);
	}
	return result.length === allIds.length && result.every((id) => allIds.includes(id)) ? null : result;
}

function clearAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (enabledIds === null) {
		return targetIds ? allIds.filter((id) => !targetIds.includes(id)) : [];
	}
	const targets = new Set(targetIds ?? enabledIds);
	return enabledIds.filter((id) => !targets.has(id));
}

function move(enabledIds: EnabledIds, id: string, delta: number): EnabledIds {
	if (enabledIds === null) return null;
	const list = [...enabledIds];
	const index = list.indexOf(id);
	if (index < 0) return list;
	const newIndex = index + delta;
	if (newIndex < 0 || newIndex >= list.length) return list;
	const result = [...list];
	[result[index], result[newIndex]] = [result[newIndex], result[index]];
	return result;
}

function getSortedIds(enabledIds: EnabledIds, allIds: string[]): string[] {
	if (enabledIds === null) return allIds;
	const enabledSet = new Set(enabledIds);
	return [...enabledIds, ...allIds.filter((id) => !enabledSet.has(id))];
}

interface ModelItem {
	fullId: string;
	model: Model<Api> | undefined;
	enabled: boolean;
}

export interface ModelsConfig {
	allModels: Model<Api>[];
	enabledModelIds: string[] | null;
}

export interface ModelsCallbacks {
	/** Called whenever the enabled model set or order changes (session-only, no persist). */
	onChange: (
		enabledModelIds: string[] | null,
		allModels: readonly Model<Api>[],
		isDirty: boolean,
	) => void | Promise<void>;
	/** Called when user wants to persist the current selection to settings. */
	onPersist: (
		enabledModelIds: string[] | null,
		allModels: readonly Model<Api>[],
		isDirty: boolean,
	) => void | Promise<void>;
	onCancel: () => void;
}

/**
 * Component for enabling/disabling models for Ctrl+P cycling.
 * Changes are session-only until explicitly persisted with Ctrl+S.
 */
export class ScopedModelsSelectorComponent extends Container implements Focusable {
	private modelsById: Map<string, Model<Api>> = new Map();
	private allIds: string[] = [];
	private enabledIds: EnabledIds = null;
	private filteredItems: ModelItem[] = [];
	private selectedIndex = 0;
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private footerText: Text;
	private callbacks: ModelsCallbacks;
	private maxVisible = 8;
	private isDirty = false;
	private refreshStatusMessage: string | undefined;
	private refreshStatusSuccess = false;
	private refreshErrorMessage: string | undefined;
	private readonly refreshAbortController = new AbortController();
	private closed = false;

	constructor(config: ModelsConfig, callbacks: ModelsCallbacks) {
		super();
		this.callbacks = callbacks;
		this.replaceModels(config.allModels);
		this.enabledIds = config.enabledModelIds === null ? null : [...config.enabledModelIds];
		this.filteredItems = this.buildItems();

		// Header
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Model Configuration")), 0, 0));
		this.addChild(
			new Text(theme.fg("muted", `Session-only. ${keyText("app.models.save")} to save to settings.`), 0, 0),
		);
		this.addChild(new Spacer(1));

		// Search input
		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		// List container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		// Footer hint
		this.addChild(new Spacer(1));
		this.footerText = new Text(this.getFooterText(), 0, 0);
		this.addChild(this.footerText);

		this.addChild(new DynamicBorder());
		this.updateList();
	}

	get refreshSignal(): AbortSignal {
		return this.refreshAbortController.signal;
	}

	get disposed(): boolean {
		return this.closed;
	}

	abortRefresh(): void {
		this.refreshAbortController.abort();
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.abortRefresh();
	}

	beginRefresh(): void {
		if (this.closed) return;
		this.refreshStatusMessage = "Refreshing model catalogs…";
		this.refreshStatusSuccess = false;
		this.refreshErrorMessage = undefined;
		this.updateList();
	}

	/** Replace the catalog displayed by this mounted selector without resetting user state. */
	applyCatalogRefresh(allModels: readonly Model<Api>[], errorMessage?: string): void {
		if (this.closed) return;
		const selectedId = this.filteredItems[this.selectedIndex]?.fullId;
		const previousFilteredIndex = this.selectedIndex;
		this.replaceModels(allModels);
		this.refreshStatusMessage = errorMessage === undefined ? "Model catalogs refreshed." : undefined;
		this.refreshStatusSuccess = errorMessage === undefined;
		this.refreshErrorMessage = errorMessage;
		this.rebuild(selectedId, previousFilteredIndex);
	}

	setRefreshError(errorMessage: string): void {
		if (this.closed) return;
		this.refreshStatusMessage = undefined;
		this.refreshStatusSuccess = false;
		this.refreshErrorMessage = this.refreshErrorMessage
			? `${this.refreshErrorMessage} ${errorMessage}`
			: errorMessage;
		this.updateList();
	}

	/**
	 * Replace the preliminary raw-pattern rows with a catalog-resolved scope.
	 * User edits always win over the asynchronous resolution.
	 */
	applyResolvedEnabledModelIds(enabledModelIds: string[] | null): void {
		if (this.closed || this.isDirty) return;
		const selectedId = this.filteredItems[this.selectedIndex]?.fullId;
		const previousFilteredIndex = this.selectedIndex;
		this.enabledIds = enabledModelIds === null ? null : [...enabledModelIds];
		this.rebuild(selectedId, previousFilteredIndex);
	}

	private replaceModels(models: readonly Model<Api>[]): void {
		this.modelsById.clear();
		this.allIds = [];
		for (const model of models) {
			const fullId = `${model.provider}/${model.id}`;
			this.modelsById.set(fullId, model);
			this.allIds.push(fullId);
		}
	}

	private getAllModels(): readonly Model<Api>[] {
		return this.allIds.map((id) => this.modelsById.get(id)!);
	}

	private buildItems(): ModelItem[] {
		return getSortedIds(this.enabledIds, this.allIds).map((id) => ({
			fullId: id,
			model: this.modelsById.get(id),
			enabled: isEnabled(this.enabledIds, id),
		}));
	}

	private getFooterText(): string {
		const enabledCount = this.enabledIds?.filter((id) => this.modelsById.has(id)).length ?? this.allIds.length;
		const unavailableCount = this.enabledIds?.filter((id) => !this.modelsById.has(id)).length ?? 0;
		const allEnabled = this.enabledIds === null;
		const countText = allEnabled
			? "all enabled"
			: `${enabledCount}/${this.allIds.length} enabled${unavailableCount ? ` · ${unavailableCount} unavailable` : ""}`;
		const parts = [
			`${keyText("tui.select.confirm")} toggle`,
			`${keyText("app.models.enableAll")} all`,
			`${keyText("app.models.clearAll")} clear`,
			`${keyText("app.models.toggleProvider")} provider`,
			`${keyText("app.models.reorderUp")}/${keyText("app.models.reorderDown")} reorder`,
			`${keyText("app.models.save")} save`,
			countText,
		];
		return this.isDirty
			? theme.fg("dim", `  ${parts.join(" · ")} `) + theme.fg("warning", "(unsaved)")
			: theme.fg("dim", `  ${parts.join(" · ")}`);
	}

	private refresh(): void {
		this.rebuild(undefined, this.selectedIndex);
	}

	private rebuild(selectedId: string | undefined, previousFilteredIndex: number): void {
		const query = this.searchInput.getValue();
		const items = this.buildItems();
		this.filteredItems = query
			? fuzzyFilter(items, query, (item) =>
					item.model
						? getModelSearchText({ id: item.model.id, provider: item.model.provider, name: item.model.name })
						: item.fullId,
				)
			: items;
		const selectedIndex = selectedId ? this.filteredItems.findIndex((item) => item.fullId === selectedId) : -1;
		this.selectedIndex =
			selectedIndex >= 0
				? selectedIndex
				: Math.min(previousFilteredIndex, Math.max(0, this.filteredItems.length - 1));
		this.updateList();
		this.footerText.setText(this.getFooterText());
	}

	private notifyChange(): void {
		const result = this.callbacks.onChange(
			this.enabledIds === null ? null : [...this.enabledIds],
			this.getAllModels(),
			this.isDirty,
		);
		if (result && typeof (result as Promise<void>).then === "function") {
			void (result as Promise<void>).catch((error) => {
				console.error("Could not apply scoped model selection:", error);
			});
		}
	}

	private updateList(): void {
		this.listContainer.clear();
		const noCachedModels = this.allIds.length === 0 && this.searchInput.getValue() === "";

		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", noCachedModels ? "  No cached models yet." : "  No matching models"), 0, 0),
			);
		} else {
			const startIndex = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
			);
			const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);
			const allEnabled = this.enabledIds === null;

			for (let i = startIndex; i < endIndex; i++) {
				const item = this.filteredItems[i]!;
				const isSelected = i === this.selectedIndex;
				const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
				const id = item.model?.id ?? item.fullId;
				const modelText = isSelected ? theme.fg("accent", id) : id;
				const providerBadge = theme.fg("muted", item.model ? ` [${item.model.provider}]` : " [unavailable]");
				const status = item.model
					? allEnabled
						? ""
						: item.enabled
							? theme.fg("success", " ✓")
							: theme.fg("dim", " ✗")
					: theme.fg("dim", " ✗");
				this.listContainer.addChild(new Text(`${prefix}${modelText}${providerBadge}${status}`, 0, 0));
			}

			// Add scroll indicator if needed
			if (startIndex > 0 || endIndex < this.filteredItems.length) {
				this.listContainer.addChild(
					new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 0, 0),
				);
			}

			if (this.filteredItems.length > 0) {
				const selected = this.filteredItems[this.selectedIndex];
				this.listContainer.addChild(new Spacer(1));
				this.listContainer.addChild(
					new Text(
						theme.fg("muted", `  ${selected.model ? `Model Name: ${selected.model.name}` : "Model unavailable"}`),
						0,
						0,
					),
				);
			}
		}

		if (noCachedModels && this.filteredItems.length > 0) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(theme.fg("muted", "  No cached models yet."), 0, 0));
		}
		if (this.refreshErrorMessage) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(theme.fg("error", `  ${this.refreshErrorMessage}`), 0, 0));
		}
		if (this.refreshStatusMessage) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(
				new Text(theme.fg(this.refreshStatusSuccess ? "success" : "muted", `  ${this.refreshStatusMessage}`), 0, 0),
			);
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// Navigation
		if (kb.matches(data, "tui.select.up")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}

		// Reorder enabled models
		const reorderUp = kb.matches(data, "app.models.reorderUp");
		const reorderDown = kb.matches(data, "app.models.reorderDown");
		if (reorderUp || reorderDown) {
			if (this.enabledIds === null) return;
			const item = this.filteredItems[this.selectedIndex];
			if (item && isEnabled(this.enabledIds, item.fullId)) {
				const delta = reorderUp ? -1 : 1;
				const currentIndex = this.enabledIds.indexOf(item.fullId);
				const newIndex = currentIndex + delta;
				// Only move if within bounds
				if (newIndex >= 0 && newIndex < this.enabledIds.length) {
					this.enabledIds = move(this.enabledIds, item.fullId, delta);
					this.isDirty = true;
					this.selectedIndex += delta;
					this.refresh();
					this.notifyChange();
				}
			}
			return;
		}

		// Toggle on Enter
		if (kb.matches(data, "tui.select.confirm")) {
			const item = this.filteredItems[this.selectedIndex];
			if (item) {
				this.enabledIds = toggle(this.enabledIds, item.fullId);
				this.isDirty = true;
				this.refresh();
				this.notifyChange();
			}
			return;
		}

		// Enable all (filtered if search active, otherwise all)
		if (kb.matches(data, "app.models.enableAll")) {
			const targetIds = this.searchInput.getValue() ? this.filteredItems.map((i) => i.fullId) : undefined;
			this.enabledIds = enableAll(this.enabledIds, this.allIds, targetIds);
			this.isDirty = true;
			this.refresh();
			this.notifyChange();
			return;
		}

		// Clear all (filtered if search active, otherwise all)
		if (kb.matches(data, "app.models.clearAll")) {
			const targetIds = this.searchInput.getValue() ? this.filteredItems.map((i) => i.fullId) : undefined;
			this.enabledIds = clearAll(this.enabledIds, this.allIds, targetIds);
			this.isDirty = true;
			this.refresh();
			this.notifyChange();
			return;
		}

		// Toggle provider of current item
		if (kb.matches(data, "app.models.toggleProvider")) {
			const item = this.filteredItems[this.selectedIndex];
			if (item?.model) {
				const provider = item.model.provider;
				const providerIds = this.allIds.filter((id) => this.modelsById.get(id)!.provider === provider);
				const allEnabled = providerIds.every((id) => isEnabled(this.enabledIds, id));
				this.enabledIds = allEnabled
					? clearAll(this.enabledIds, this.allIds, providerIds)
					: enableAll(this.enabledIds, this.allIds, providerIds);
				this.isDirty = true;
				this.refresh();
				this.notifyChange();
			}
			return;
		}

		// Save/persist to settings
		if (kb.matches(data, "app.models.save")) {
			const result = this.callbacks.onPersist(
				this.enabledIds === null ? null : [...this.enabledIds],
				this.getAllModels(),
				this.isDirty,
			);
			if (result && typeof (result as Promise<void>).then === "function") {
				void (result as Promise<void>).catch((error) => {
					console.error("Could not persist scoped model selection:", error);
				});
			}
			this.isDirty = false;
			this.footerText.setText(this.getFooterText());
			return;
		}

		// Ctrl+C - clear search or cancel if empty
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.refresh();
			} else {
				this.callbacks.onCancel();
			}
			return;
		}

		// Escape - cancel
		if (matchesKey(data, Key.escape)) {
			this.callbacks.onCancel();
			return;
		}

		// Pass everything else to search input
		this.searchInput.handleInput(data);
		this.refresh();
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
