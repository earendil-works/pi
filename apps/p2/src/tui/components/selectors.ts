// Copied from coding-agent interactive/components/{dynamic-border,model-selector,thinking-selector}.ts with the
// instance theme and key hints (section 5.4). The model selector takes data and actions instead of `ModelRuntime`
// (section 11): the owner's catalog, the scope (`enabledModels`), the current and default model. It does not refresh
// provider catalogs (the server keeps them; `/login` is P6).
import {
	type Component,
	Container,
	type Focusable,
	fuzzyFilter,
	Input,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { keyHint, lineText, type RenderContext } from "../render-context.ts";

/** Key matching over pi's ids (the runtime's manager, installed with setKeybindings). */
export type SelectorContext = RenderContext & { keys: { matches(data: string, id: string): boolean } };

export class DynamicBorder implements Component {
	private ctx: RenderContext;
	private token: "border" | "borderAccent" | "borderMuted";
	constructor(ctx: RenderContext, token: "border" | "borderAccent" | "borderMuted" = "border") {
		this.ctx = ctx;
		this.token = token;
	}
	invalidate(): void {}
	render(width: number): string[] {
		return [this.ctx.theme.current.fg(this.token, "─".repeat(Math.max(1, width)))];
	}
}

export type SelectorModel = { provider: string; modelId: string; name: string };
type ModelRef = { provider: string; modelId: string };
const same = (a: ModelRef | undefined, b: ModelRef | undefined): boolean =>
	a !== undefined && b !== undefined && a.provider === b.provider && a.modelId === b.modelId;

/** coding-agent model-search.ts `getModelSelectorSearchText`. */
const searchText = (model: SelectorModel): string =>
	`${model.provider} ${model.provider}/${model.modelId} ${model.provider} ${model.modelId} ${model.name}`;

export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput = new Input();
	private listContainer = new Container();
	private allModels: SelectorModel[];
	private scopedModels: SelectorModel[];
	private activeModels: SelectorModel[];
	private filteredModels: SelectorModel[] = [];
	private selectedIndex = 0;
	private scope: "all" | "scoped";
	private scopeText?: Text;
	private ctx: SelectorContext;
	private current?: ModelRef;
	private defaultModel?: ModelRef;
	private onSelectCallback: (model: SelectorModel) => void;
	private onSelectAsDefaultCallback?: (model: SelectorModel) => void;
	private onCancelCallback: () => void;
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		ctx: SelectorContext,
		options: {
			models: readonly SelectorModel[];
			scoped: readonly SelectorModel[];
			current?: ModelRef;
			defaultModel?: ModelRef;
			initialSearch?: string;
			title?: string;
			onSelect: (model: SelectorModel) => void;
			onSelectAsDefault?: (model: SelectorModel) => void;
			onCancel: () => void;
		},
	) {
		super();
		this.ctx = ctx;
		this.current = options.current;
		this.defaultModel = options.defaultModel;
		this.onSelectCallback = options.onSelect;
		this.onSelectAsDefaultCallback = options.onSelectAsDefault;
		this.onCancelCallback = options.onCancel;
		this.allModels = this.sortModels([...options.models]);
		this.scopedModels = [...options.scoped];
		this.scope = this.scopedModels.length > 0 ? "scoped" : "all";
		this.activeModels = this.scope === "scoped" ? this.scopedModels : this.allModels;
		const theme = ctx.theme.current;
		this.addChild(new DynamicBorder(ctx));
		this.addChild(new Spacer(1));
		if (options.title) this.addChild(new Text(theme.bold(options.title), 0, 0));
		if (this.scopedModels.length > 0) {
			this.scopeText = new Text(this.getScopeText(), 0, 0);
			this.addChild(this.scopeText);
			this.addChild(
				new Text(`${keyHint(ctx, "tui.input.tab", "scope")}${theme.fg("muted", " (all/scoped)")}`, 0, 0),
			);
		} else
			this.addChild(
				new Text(
					theme.fg("warning", "Only showing models from signed-in providers. Use /login to add providers."),
					0,
					0,
				),
			);
		this.addChild(new Spacer(1));
		if (options.initialSearch) this.searchInput.setValue(options.initialSearch);
		this.searchInput.onSubmit = () => {
			const model = this.filteredModels[this.selectedIndex];
			if (model) this.onSelectCallback(model);
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		const save = this.onSelectAsDefaultCallback ? ` · ${ctx.keyText("app.models.save")} to set as default` : "";
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					`  ${ctx.keyText("tui.select.confirm")} to select${save} · ${ctx.keyText("tui.select.cancel")} to cancel`,
				),
				0,
				0,
			),
		);
		this.addChild(new DynamicBorder(ctx));
		this.filterModels(this.searchInput.getValue());
		const currentIndex = this.filteredModels.findIndex((model) => same(model, this.current));
		if (currentIndex >= 0 && !options.initialSearch) {
			this.selectedIndex = currentIndex;
			this.updateList();
		}
	}

	private sortModels(models: SelectorModel[]): SelectorModel[] {
		// Current model first, default second, then by provider (pi).
		return models.sort(
			(a, b) =>
				Number(same(b, this.current)) - Number(same(a, this.current)) ||
				Number(same(b, this.defaultModel)) - Number(same(a, this.defaultModel)) ||
				a.provider.localeCompare(b.provider),
		);
	}

	private getScopeText(): string {
		const theme = this.ctx.theme.current;
		const label = (scope: "all" | "scoped") => theme.fg(this.scope === scope ? "accent" : "muted", scope);
		return `${theme.fg("muted", "Scope: ")}${label("all")}${theme.fg("muted", " | ")}${label("scoped")}`;
	}

	private filterModels(query: string): void {
		if (query) {
			const filtered = fuzzyFilter(
				this.activeModels,
				query,
				(model) => `${searchText(model)}${same(model, this.defaultModel) ? " default" : ""}`,
			);
			const normalized = query.trim().toLowerCase();
			const defaults =
				normalized && "default".startsWith(normalized)
					? this.activeModels.filter((model) => same(model, this.defaultModel))
					: [];
			this.filteredModels = [...defaults, ...filtered.filter((model) => !defaults.includes(model))];
		} else this.filteredModels = this.activeModels;
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private updateList(): void {
		const theme = this.ctx.theme.current;
		this.listContainer.clear();
		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);
		for (let i = startIndex; i < endIndex; i++) {
			const model = this.filteredModels[i]!;
			const selected = i === this.selectedIndex;
			const cursor = selected ? theme.fg("accent", "→ ") : "  ";
			const marker = same(model, this.current) ? theme.fg("accent", "✓ ") : "  ";
			const id = lineText(model.modelId);
			const text = selected ? theme.fg("accent", id) : id;
			const badge = same(model, this.defaultModel) ? theme.fg("muted", " · default") : "";
			this.listContainer.addChild(
				new Text(`${cursor}${marker}${text} ${theme.fg("muted", `[${lineText(model.provider)}]`)}${badge}`, 0, 0),
			);
		}
		if (startIndex > 0 || endIndex < this.filteredModels.length)
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`), 0, 0),
			);
		if (this.filteredModels.length === 0)
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		else {
			const selected = this.filteredModels[this.selectedIndex];
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  Model Name: ${lineText(selected?.name ?? "")}`), 0, 0),
			);
		}
	}

	handleInput(data: string): void {
		const keys = this.ctx.keys;
		if (keys.matches(data, "tui.input.tab")) {
			if (this.scopedModels.length > 0) {
				this.scope = this.scope === "all" ? "scoped" : "all";
				this.activeModels = this.scope === "scoped" ? this.scopedModels : this.allModels;
				const index = this.activeModels.findIndex((model) => same(model, this.current));
				this.selectedIndex = index >= 0 ? index : 0;
				this.scopeText?.setText(this.getScopeText());
				this.filterModels(this.searchInput.getValue());
			}
		} else if (keys.matches(data, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			this.updateList();
		} else if (keys.matches(data, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		} else if (keys.matches(data, "tui.select.confirm")) {
			const model = this.filteredModels[this.selectedIndex];
			if (model) this.onSelectCallback(model);
		} else if (keys.matches(data, "tui.select.cancel")) this.onCancelCallback();
		else if (keys.matches(data, "app.models.save") && this.onSelectAsDefaultCallback) {
			const model = this.filteredModels[this.selectedIndex];
			if (model) this.onSelectAsDefaultCallback(model);
		} else {
			this.searchInput.handleInput(data);
			this.filterModels(this.searchInput.getValue());
		}
	}
}

const LEVEL_DESCRIPTIONS: Record<string, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

export class ThinkingSelectorComponent extends Container implements Focusable {
	private searchInput = new Input();
	private selectList: SelectList;
	private selectListChildIndex: number;
	private allItems: SelectItem[];
	private ctx: SelectorContext;
	private onSelect: (level: string) => void;
	private onCancel: () => void;
	private onSelectAsDefault?: (level: string) => void;
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		ctx: SelectorContext,
		options: {
			current: string;
			levels: readonly string[];
			defaultLevel?: string;
			onSelect: (level: string) => void;
			onCancel: () => void;
			onSelectAsDefault?: (level: string) => void;
		},
	) {
		super();
		this.ctx = ctx;
		this.onSelect = options.onSelect;
		this.onCancel = options.onCancel;
		this.onSelectAsDefault = options.onSelectAsDefault;
		const theme = ctx.theme.current;
		this.allItems = options.levels.map((level) => ({
			value: level,
			label: `${level === options.current ? "✓ " : "  "}${level}`,
			description: `${LEVEL_DESCRIPTIONS[level] ?? level}${level === options.defaultLevel ? " · default" : ""}`,
		}));
		this.addChild(new DynamicBorder(ctx));
		this.addChild(new Spacer(1));
		this.addChild(new Text("Thinking Level", 0, 0));
		this.addChild(new Spacer(1));
		const cycle = ctx.keyText("app.thinking.cycle");
		if (cycle) this.addChild(new Text(`${cycle} cycles thinking levels in-session`, 0, 0));
		this.addChild(new Spacer(1));
		this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.selectList = this.buildSelectList(this.allItems, options.current);
		this.selectListChildIndex = this.children.length;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		const save = this.onSelectAsDefault ? ` · ${ctx.keyText("app.thinking.save")} to set as default` : "";
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					`  ${ctx.keyText("tui.select.confirm")} to select${save} · ${ctx.keyText("tui.select.cancel")} to cancel`,
				),
				0,
				0,
			),
		);
		this.addChild(new DynamicBorder(ctx));
	}

	private buildSelectList(items: SelectItem[], preselect?: string): SelectList {
		const list = new SelectList(items, Math.max(1, items.length), this.ctx.theme.selectList, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 32,
		});
		const index = items.findIndex((item) => item.value === preselect);
		if (index !== -1) list.setSelectedIndex(index);
		list.onSelect = (item) => this.onSelect(item.value);
		list.onCancel = () => this.onCancel();
		return list;
	}

	handleInput(data: string): void {
		const keys = this.ctx.keys;
		if (keys.matches(data, "app.thinking.save") && this.onSelectAsDefault) {
			const item = this.selectList.getSelectedItem();
			if (item) this.onSelectAsDefault(item.value);
			return;
		}
		if (
			["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"].some((id) =>
				keys.matches(data, id),
			)
		) {
			this.selectList.handleInput(data);
			return;
		}
		this.searchInput.handleInput(data);
		const query = this.searchInput.getValue();
		const filtered = query
			? fuzzyFilter(this.allItems, query, (item) => `${item.value} ${item.description ?? ""}`)
			: this.allItems;
		const list = this.buildSelectList(filtered, this.selectList.getSelectedItem()?.value);
		this.children[this.selectListChildIndex] = list;
		this.selectList = list;
	}
}

/**
 * pi's `/scoped-models` (scoped-models-selector.ts), reduced: every catalog model with a check mark when enabled;
 * Enter or Space toggles, Ctrl+S saves the scope as exact `provider/modelId` patterns in catalog order (the owner's
 * settings.json `enabledModels`, replacing hand-written globs), Escape cancels.
 */
export class ScopedModelsSelectorComponent extends Container implements Focusable {
	private searchInput = new Input();
	private listContainer = new Container();
	private ctx: SelectorContext;
	private models: SelectorModel[];
	private enabled: Set<string>;
	private filtered: SelectorModel[] = [];
	private selectedIndex = 0;
	private onSave: (enabled: string[]) => void;
	private onCancel: () => void;
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	constructor(
		ctx: SelectorContext,
		options: {
			models: readonly SelectorModel[];
			enabled: readonly ModelRef[];
			onSave: (enabled: string[]) => void;
			onCancel: () => void;
		},
	) {
		super();
		this.ctx = ctx;
		this.models = [...options.models];
		this.enabled = new Set(options.enabled.map((model) => `${model.provider}/${model.modelId}`));
		this.onSave = options.onSave;
		this.onCancel = options.onCancel;
		const theme = ctx.theme.current;
		this.addChild(new DynamicBorder(ctx));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Scoped models"), 0, 0));
		this.addChild(new Text(theme.fg("muted", "Models cycled with the model cycle keys, in this order."), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					`  ${ctx.keyText("tui.select.confirm")}/space to toggle · ${ctx.keyText("app.models.save")} to save · ${ctx.keyText("tui.select.cancel")} to cancel`,
				),
				0,
				0,
			),
		);
		this.addChild(new DynamicBorder(ctx));
		this.filter();
	}
	private key = (model: SelectorModel) => `${model.provider}/${model.modelId}`;
	private filter(): void {
		const query = this.searchInput.getValue();
		this.filtered = query ? fuzzyFilter(this.models, query, searchText) : this.models;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
		this.update();
	}
	private update(): void {
		const theme = this.ctx.theme.current;
		this.listContainer.clear();
		const maxVisible = 10;
		const start = Math.max(0, Math.min(this.selectedIndex - 5, this.filtered.length - maxVisible));
		for (const [offset, model] of this.filtered.slice(start, start + maxVisible).entries()) {
			const selected = start + offset === this.selectedIndex;
			const on = this.enabled.has(this.key(model));
			const line = `${selected ? theme.fg("accent", "→ ") : "  "}${on ? theme.fg("success", "[x] ") : theme.fg("muted", "[ ] ")}${lineText(model.modelId)} ${theme.fg("muted", `[${lineText(model.provider)}]`)}`;
			this.listContainer.addChild(new Text(line, 0, 0));
		}
		if (this.filtered.length === 0)
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		this.listContainer.addChild(new Text(theme.fg("muted", `  ${this.enabled.size} enabled`), 0, 0));
	}
	handleInput(data: string): void {
		const keys = this.ctx.keys;
		if (keys.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.update();
		} else if (keys.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(Math.max(0, this.filtered.length - 1), this.selectedIndex + 1);
			this.update();
		} else if (keys.matches(data, "tui.select.confirm") || data === " ") {
			const model = this.filtered[this.selectedIndex];
			if (!model) return;
			const key = this.key(model);
			if (this.enabled.has(key)) this.enabled.delete(key);
			else this.enabled.add(key);
			this.update();
		} else if (keys.matches(data, "app.models.save"))
			this.onSave(this.models.map(this.key).filter((key) => this.enabled.has(key)));
		else if (keys.matches(data, "tui.select.cancel")) this.onCancel();
		else {
			this.searchInput.handleInput(data);
			this.filter();
		}
	}
}
