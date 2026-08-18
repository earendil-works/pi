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
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { LlamaModelInfo, LlamaProgress } from "./client.ts";
import type { HuggingFaceModel } from "./huggingface.ts";

const DOWNLOAD_VALUE = "\0download";

export type LlamaManagerAction = { type: "model"; model: LlamaModelInfo } | { type: "download" } | { type: "close" };

interface ProgressState extends LlamaProgress {
	title: string;
	model: string;
}

function contextLabel(model: LlamaModelInfo): string | undefined {
	const context = model.meta?.n_ctx ?? model.meta?.n_ctx_train;
	if (context) return context >= 1000 ? `${Math.round(context / 1000)}k` : String(context);
	const args = model.status.args ?? [];
	for (let index = 0; index < args.length - 1; index++) {
		if (args[index] !== "--ctx-size" && args[index] !== "-c" && args[index] !== "-ctx") continue;
		const value = Number(args[index + 1]);
		if (Number.isFinite(value) && value > 0) return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
	}
	return undefined;
}

function modelDescription(model: LlamaModelInfo): string {
	const details: string[] = [];
	const loaded = model.status.value === "loaded" || model.status.value === "sleeping";
	if (loaded) details.push("loaded");
	else if (model.status.value !== "unloaded") details.push(model.status.value);
	const context = loaded ? contextLabel(model) : undefined;
	if (context) details.push(`${context} context`);
	return details.join(" · ");
}

function selectTheme(theme: Theme) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

function frame(theme: Theme, title: string, body: Component[], footer?: string): Container {
	const container = new Container();
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	for (const child of body) container.addChild(child);
	if (footer) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", footer), 1, 0));
	}
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	return container;
}

export interface LlamaUi {
	showModels(serverUrl: string, models: LlamaModelInfo[]): Promise<LlamaManagerAction>;
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	connectionError(serverUrl: string, message: string): Promise<"retry" | "close">;
	searchModels(
		search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>,
	): Promise<string | undefined>;
	showStatus(title: string, message: string): void;
	progress(state: ProgressState): Promise<void>;
	updateProgress(state: ProgressState): void;
}

function compactCount(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
	return String(value);
}

class HuggingFaceSearch extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>;
	private readonly cache: Map<string, HuggingFaceModel[]>;
	private readonly onSelectModel: (model: string | undefined) => void;
	private readonly input = new Input();
	private readonly resultsContainer = new Container();
	private results: HuggingFaceModel[] = [];
	private filteredResults: HuggingFaceModel[] = [];
	private selectedIndex = 0;
	private query = "";
	private status = "Type at least 2 characters";
	private debounce: ReturnType<typeof setTimeout> | undefined;
	private request: AbortController | undefined;
	private closed = false;
	private _focused = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>,
		cache: Map<string, HuggingFaceModel[]>,
		onSelectModel: (model: string | undefined) => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.search = search;
		this.cache = cache;
		this.onSelectModel = onSelectModel;
		this.addChild(new Text(theme.fg("dim", "Model name or owner/repository[:quant]"), 1, 0));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(this.resultsContainer);
		this.updateResults();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	private updateResults(): void {
		this.resultsContainer.clear();
		const maxVisible = 10;
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredResults.length - maxVisible),
		);
		const end = Math.min(start + maxVisible, this.filteredResults.length);
		for (let index = start; index < end; index++) {
			const model = this.filteredResults[index];
			if (!model) continue;
			const prefix = index === this.selectedIndex ? "→ " : "  ";
			const details = `${compactCount(model.downloads)} downloads`;
			this.resultsContainer.addChild(
				new Text(
					index === this.selectedIndex
						? this.theme.fg("accent", `${prefix}${model.id}  ${details}`)
						: `${prefix}${model.id}${this.theme.fg("muted", `  ${details}`)}`,
					0,
					0,
				),
			);
		}
		if (start > 0 || end < this.filteredResults.length) {
			this.resultsContainer.addChild(
				new Text(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.filteredResults.length})`), 0, 0),
			);
		}
		if (this.filteredResults.length === 0) {
			this.resultsContainer.addChild(new Text(this.theme.fg("dim", `  ${this.status}`), 0, 0));
		} else if (this.status === "Searching Hugging Face…") {
			this.resultsContainer.addChild(new Text(this.theme.fg("dim", `  ${this.status}`), 0, 0));
		}
		this.tui.requestRender();
	}

	private filterResults(): void {
		if (this.query) {
			const matches = new Set(fuzzyFilter(this.results, this.query, (model) => model.id).map((model) => model.id));
			this.filteredResults = this.results.filter((model) => matches.has(model.id));
		} else {
			this.filteredResults = this.results;
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredResults.length - 1));
		this.updateResults();
	}

	private scheduleSearch(): void {
		if (this.debounce) clearTimeout(this.debounce);
		this.request?.abort();
		this.request = undefined;
		if (this.query.length < 2) {
			this.status = "Type at least 2 characters";
			this.filterResults();
			return;
		}
		const cached = this.cache.get(this.query.toLowerCase());
		if (cached) {
			this.results = cached;
			this.status = cached.length === 0 ? "No GGUF models found" : "";
			this.filterResults();
			return;
		}
		this.status = "Searching Hugging Face…";
		this.filterResults();
		this.debounce = setTimeout(() => void this.runSearch(this.query), 500);
	}

	private async runSearch(query: string): Promise<void> {
		const request = new AbortController();
		this.request = request;
		try {
			const results = await this.search(query, request.signal);
			this.cache.set(query.toLowerCase(), results);
			if (this.closed || request.signal.aborted || this.query !== query) return;
			this.results = results;
			this.selectedIndex = 0;
			this.status = results.length === 0 ? "No GGUF models found" : "";
			this.filterResults();
		} catch (error) {
			if (this.closed || request.signal.aborted || this.query !== query) return;
			this.results = [];
			this.status = error instanceof Error ? error.message : String(error);
			this.filterResults();
		} finally {
			if (this.request === request) this.request = undefined;
		}
	}

	private close(model: string | undefined): void {
		if (this.closed) return;
		this.closed = true;
		if (this.debounce) clearTimeout(this.debounce);
		this.request?.abort();
		this.onSelectModel(model);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			if (this.filteredResults.length > 0) {
				this.selectedIndex = this.selectedIndex === 0 ? this.filteredResults.length - 1 : this.selectedIndex - 1;
				this.updateResults();
			}
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			if (this.filteredResults.length > 0) {
				this.selectedIndex = this.selectedIndex === this.filteredResults.length - 1 ? 0 : this.selectedIndex + 1;
				this.updateResults();
			}
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const exact = /^[^/\s]+\/[^:\s]+(?::[^\s:]+)?$/u.test(this.query) ? this.query : undefined;
			const selected = exact ?? this.filteredResults[this.selectedIndex]?.id;
			if (selected) this.close(selected);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.close(undefined);
			return;
		}
		this.input.handleInput(data);
		const query = this.input.getValue().trim();
		if (query === this.query) return;
		this.query = query;
		this.scheduleSearch();
	}
}

class LlamaView implements LlamaUi, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly searchCache = new Map<string, HuggingFaceModel[]>();
	private content: Container;
	private inputHandler: { handleInput?(data: string): void } | undefined;
	private inputTarget: Focusable | undefined;
	private progressPromise: Promise<void> | undefined;
	private progressResolver: (() => void) | undefined;
	private showingProgress = false;
	private _focused = false;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.content = frame(theme, "llama.cpp models", [new Text(theme.fg("muted", "Loading…"), 1, 1)]);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.inputTarget) this.inputTarget.focused = value;
	}

	private setContent(
		content: Container,
		inputHandler?: { handleInput?(data: string): void },
		inputTarget?: Focusable,
	): void {
		if (this.inputTarget) this.inputTarget.focused = false;
		this.progressPromise = undefined;
		this.progressResolver = undefined;
		this.showingProgress = false;
		this.content = content;
		this.inputHandler = inputHandler;
		this.inputTarget = inputTarget;
		if (this.inputTarget) this.inputTarget.focused = this._focused;
		this.tui.requestRender();
	}

	showModels(serverUrl: string, models: LlamaModelInfo[]): Promise<LlamaManagerAction> {
		const sorted = [...models].sort((left, right) => {
			const loaded = Number(right.status.value === "loaded") - Number(left.status.value === "loaded");
			return loaded || left.id.localeCompare(right.id);
		});
		const byId = new Map(sorted.map((model) => [model.id, model]));
		const items: SelectItem[] = [
			...sorted.map((model) => ({
				value: model.id,
				label: model.id,
				description: modelDescription(model),
			})),
			{ value: DOWNLOAD_VALUE, label: "Download model…", description: "Hugging Face owner/repository[:quant]" },
		];
		return new Promise((resolve) => {
			const list = new SelectList(items, Math.min(items.length, 12), selectTheme(this.theme), {
				minPrimaryColumnWidth: 36,
				maxPrimaryColumnWidth: 56,
			});
			list.onSelect = (item) => {
				if (item.value === DOWNLOAD_VALUE) resolve({ type: "download" });
				else {
					const model = byId.get(item.value);
					if (model) resolve({ type: "model", model });
				}
			};
			list.onCancel = () => resolve({ type: "close" });
			this.setContent(
				frame(
					this.theme,
					"llama.cpp models",
					[new Text(this.theme.fg("dim", serverUrl), 1, 0), new Spacer(1), list],
					`${keyHint("tui.select.confirm", "load/unload/download")} • ${keyHint("tui.select.cancel", "close")}`,
				),
				list,
			);
		});
	}

	select(title: string, options: string[]): Promise<string | undefined> {
		return new Promise((resolve) => {
			const list = new SelectList(
				options.map((option) => ({ value: option, label: option })),
				Math.min(options.length, 12),
				selectTheme(this.theme),
			);
			list.onSelect = (item) => resolve(item.value);
			list.onCancel = () => resolve(undefined);
			this.setContent(
				frame(
					this.theme,
					title,
					[new Spacer(1), list],
					`${keyHint("tui.select.confirm", "select")} • ${keyHint("tui.select.cancel", "cancel")}`,
				),
				list,
			);
		});
	}

	async confirm(title: string, message: string): Promise<boolean> {
		return (await this.select(`${title}\n${message}`, ["Yes", "No"])) === "Yes";
	}

	async connectionError(serverUrl: string, message: string): Promise<"retry" | "close"> {
		const choice = await this.select(`llama.cpp unavailable\n${serverUrl}\n\n${message}`, ["Retry", "Close"]);
		return choice === "Retry" ? "retry" : "close";
	}

	searchModels(
		search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			const component = new HuggingFaceSearch(
				this.tui,
				this.theme,
				this.keybindings,
				search,
				this.searchCache,
				resolve,
			);
			this.setContent(
				frame(
					this.theme,
					"Download model",
					[new Spacer(1), component],
					`${keyHint("tui.select.confirm", "select")} • ${keyHint("tui.select.cancel", "back")}`,
				),
				component,
				component,
			);
		});
	}

	showStatus(title: string, message: string): void {
		this.setContent(frame(this.theme, title, [new Spacer(1), new Text(this.theme.fg("muted", message), 1, 0)]));
	}

	progress(state: ProgressState): Promise<void> {
		if (!this.progressPromise) {
			this.progressPromise = new Promise((resolve) => {
				this.progressResolver = resolve;
			});
		}
		this.showingProgress = true;
		this.updateProgress(state);
		return this.progressPromise;
	}

	updateProgress(state: ProgressState): void {
		if (!this.showingProgress) return;
		const body = [
			new Text(this.theme.fg("text", state.model), 1, 0),
			new Spacer(1),
			new Text(this.theme.fg("muted", state.message), 1, 0),
		];
		if (state.ratio !== undefined) {
			const available = 40;
			const filled = Math.round(Math.max(0, Math.min(1, state.ratio)) * available);
			body.push(
				new Text(
					this.theme.fg(
						"accent",
						`${"█".repeat(filled)}${"─".repeat(available - filled)} ${Math.round(state.ratio * 100)}%`,
					),
					1,
					0,
				),
			);
		}
		if (state.detail) body.push(new Text(this.theme.fg("dim", state.detail), 1, 0));
		this.content = frame(this.theme, state.title, body, keyHint("tui.select.cancel", "stop"));
		this.inputHandler = undefined;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.progressResolver && this.keybindings.matches(data, "tui.select.cancel")) {
			const resolve = this.progressResolver;
			this.progressPromise = undefined;
			this.progressResolver = undefined;
			resolve();
			return;
		}
		this.inputHandler?.handleInput?.(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return this.content
			.render(width)
			.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
	}

	invalidate(): void {
		this.content.invalidate();
	}
}

export async function showLlamaUi(ctx: ExtensionCommandContext, run: (ui: LlamaUi) => Promise<void>): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const view = new LlamaView(tui, theme, keybindings);
		void run(view).then(
			() => done(),
			(error: unknown) => {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				done();
			},
		);
		return view;
	});
}

export async function runWithProgress<T>(
	ui: LlamaUi,
	options: {
		title: string;
		model: string;
		initialMessage: string;
		cancelTitle: string;
		cancelMessage: string;
		run(signal: AbortSignal, update: (progress: LlamaProgress) => void): Promise<T>;
		cancel(): Promise<void>;
	},
): Promise<{ cancelled: true } | { cancelled: false; value: T }> {
	const controller = new AbortController();
	const state: ProgressState = { title: options.title, model: options.model, message: options.initialMessage };
	const settled = options
		.run(controller.signal, (progress) => {
			Object.assign(state, progress);
			ui.updateProgress(state);
		})
		.then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);
	let completed = false;
	settled.finally(() => {
		completed = true;
	});

	while (!completed) {
		const outcome = await Promise.race([
			settled.then(() => "settled" as const),
			ui.progress(state).then(() => "stop" as const),
		]);
		if (outcome === "settled") break;
		const stop = await ui.confirm(options.cancelTitle, options.cancelMessage);
		if (!stop || completed) continue;
		try {
			await options.cancel();
		} finally {
			controller.abort(new Error("Cancelled"));
		}
		await settled;
		return { cancelled: true };
	}

	const result = await settled;
	if (!result.ok) throw result.error;
	return { cancelled: false, value: result.value };
}
