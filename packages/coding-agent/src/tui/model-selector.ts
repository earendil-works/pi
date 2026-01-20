import type { Model } from "@kennyfrc/pi-ai";
import { Container, Input, Spacer, Text, type TUI } from "@kennyfrc/pi-tui";
import { getAvailableModels } from "../model-config.js";
import {
	compareModelUsage,
	getWorkspaceSessionDir,
	loadModelUsageStats,
	type ModelUsageStats,
} from "../model-usage.js";
import type { SettingsManager } from "../settings-manager.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

/**
 * Component that renders a model selector with search
 */
export class ModelSelectorComponent extends Container {
	private searchInput: Input;
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private modelUsageByKey: Map<string, ModelUsageStats> = new Map();
	private selectedIndex: number = 0;
	private currentModel: Model<any> | null;
	private settingsManager: SettingsManager;
	private onSelectCallback: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private errorMessage: string | null = null;
	private tui: TUI;

	constructor(
		tui: TUI,
		currentModel: Model<any> | null,
		settingsManager: SettingsManager,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.settingsManager = settingsManager;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add hint about API key filtering
		this.addChild(
			new Text(theme.fg("warning", "Only showing models with configured API keys (see README for details)"), 0, 0),
		);
		this.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input();
		this.searchInput.onSubmit = () => {
			// Enter on search input selects the first filtered item
			if (this.filteredModels[this.selectedIndex]) {
				this.handleSelect(this.filteredModels[this.selectedIndex].model);
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

		// Load models and do initial render
		this.loadModels().then(() => {
			this.updateList();
			// Request re-render after models are loaded
			this.tui.requestRender();
		});
	}

	private async loadModels(): Promise<void> {
		// Load available models fresh (includes custom models from ~/.pi/agent/models.json)
		const { models: availableModels, error } = await getAvailableModels();

		// If there's an error loading models.json, we'll show it via the "no models" path
		// The error will be displayed to the user
		if (error) {
			this.allModels = [];
			this.filteredModels = [];
			this.errorMessage = error;
			return;
		}

		const models: ModelItem[] = availableModels.map((model) => ({
			provider: model.provider,
			id: model.id,
			model,
		}));

		this.modelUsageByKey = loadModelUsageStats(getWorkspaceSessionDir());
		this.sortModelsByUsage(models, "recency");

		this.allModels = models;
		this.filteredModels = [...models];
	}

	private filterModels(query: string): void {
		const trimmedQuery = query.trim();
		if (!trimmedQuery) {
			this.filteredModels = [...this.allModels];
		} else {
			const searchTokens = trimmedQuery
				.toLowerCase()
				.split(/\s+/)
				.filter((t) => t);
			this.filteredModels = this.allModels.filter(({ provider, id, model }) => {
				const searchText = `${provider} ${id} ${model.name}`.toLowerCase();
				return searchTokens.every((token) => searchText.includes(token));
			});
		}

		this.sortModelsByUsage(this.filteredModels, trimmedQuery ? "frequency" : "recency");
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private sortModelsByUsage(models: ModelItem[], mode: "recency" | "frequency"): void {
		models.sort((a, b) => compareModelUsage(a, b, this.modelUsageByKey, mode));
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const isCurrent = this.currentModel?.id === item.model.id;

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", "→ ");
				const modelText = `${item.id}`;
				const providerBadge = theme.fg("muted", `[${item.provider}]`);
				const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
				line = prefix + theme.fg("accent", modelText) + " " + providerBadge + checkmark;
			} else {
				const modelText = `  ${item.id}`;
				const providerBadge = theme.fg("muted", `[${item.provider}]`);
				const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
				line = modelText + " " + providerBadge + checkmark;
			}

			this.listContainer.addChild(new Text(line, 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		// Show error message or "no results" if empty
		if (this.errorMessage) {
			// Show error in red
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		if (keyData === "\x1b[A") {
			if (this.filteredModels.length > 0) {
				this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			}
			this.updateList();
		} else if (keyData === "\x1b[B") {
			if (this.filteredModels.length > 0) {
				this.selectedIndex = this.selectedIndex >= this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			}
			this.updateList();
		} else if (keyData === "\r") {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel.model);
			}
		} else if (keyData === "\x1b") {
			this.onCancelCallback();
		} else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	private handleSelect(model: Model<any>): void {
		// Save as new default
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		this.onSelectCallback(model);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
