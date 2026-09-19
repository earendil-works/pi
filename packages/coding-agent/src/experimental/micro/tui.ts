import type { AssistantMessage, AuthEvent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	ProcessTerminal,
	ScrollView,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Spacer,
	setKeybindings,
	Text,
	TruncatedText,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import { getAgentDir } from "../../config.ts";
import { KeybindingsManager } from "../../core/keybindings.ts";
import { createAllToolRenderers } from "../../core/tools/renderers/index.ts";
import { AssistantMessageComponent } from "../../modes/interactive/components/assistant-message.ts";
import { CustomEditor } from "../../modes/interactive/components/custom-editor.ts";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
import { ExtensionSelectorComponent } from "../../modes/interactive/components/extension-selector.ts";
import { formatTokens } from "../../modes/interactive/components/footer.ts";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { LoginDialogComponent } from "../../modes/interactive/components/login-dialog.ts";
import {
	type AuthSelectorProvider,
	OAuthSelectorComponent,
} from "../../modes/interactive/components/oauth-selector.ts";
import { type StatusIndicator, WorkingStatusIndicator } from "../../modes/interactive/components/status-indicator.ts";
import { ToolExecutionComponent, type ToolRenderers } from "../../modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../../modes/interactive/components/user-message.ts";
import { getEditorTheme, initTheme, theme } from "../../modes/interactive/theme/theme.ts";
import type { MicroAuthView, MicroController, MicroProviderAccount, MicroView, MicroViewSource } from "./api.ts";

const SELECT_THEME: SelectListTheme = {
	selectedPrefix: (text) => theme.fg("accent", text),
	selectedText: (text) => theme.fg("accent", text),
	description: (text) => theme.fg("muted", text),
	scrollInfo: (text) => theme.fg("dim", text),
	noMatch: (text) => theme.fg("warning", text),
};

class ListSelector extends Container implements Focusable {
	readonly #input = new Input();
	readonly #listContainer = new Container();
	readonly #items: SelectItem[];
	readonly #onSelect: (value: string) => void;
	readonly #onCancel: () => void;
	#list: SelectList;
	#focused = false;

	constructor(title: string, items: SelectItem[], onSelect: (value: string) => void, onCancel: () => void) {
		super();
		this.#items = items;
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;
		this.#list = this.#build(items);
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(this.#input);
		this.addChild(new Spacer(1));
		this.addChild(this.#listContainer);
		this.addChild(new DynamicBorder());
	}

	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
		this.#input.focused = value;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		const forwarded = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;
		if (forwarded.some((action) => keybindings.matches(data, action))) {
			this.#list.handleInput(data);
			return;
		}
		this.#input.handleInput(data);
		const query = this.#input.getValue();
		const filtered =
			query.length === 0 ? this.#items : fuzzyFilter(this.#items, query, (item) => `${item.label} ${item.value}`);
		this.#list = this.#build(filtered);
	}

	#build(items: SelectItem[]): SelectList {
		const list = new SelectList(items, 10, SELECT_THEME);
		list.onSelect = (item) => this.#onSelect(item.value);
		list.onCancel = this.#onCancel;
		this.#listContainer.clear();
		this.#listContainer.addChild(list);
		return list;
	}
}

interface TuiHandlers {
	submit(text: string): void;
	followUp(text: string): void;
	abort(): void;
	exit(): void;
	selectModel(): void;
	cycleThinking(): void;
}

class MicroTui {
	readonly #ui: TuiAltScreen;
	readonly #chat = new Container();
	readonly #queue = new Container();
	readonly #notices = new Container();
	readonly #status = new Container();
	readonly #footer = new Container();
	readonly #footerStats = new Text("", 1, 0);
	readonly #footerHints = new Text("", 1, 0);
	readonly #editorContainer = new Container();
	readonly #editor: CustomEditor;
	readonly #cwd: string;
	readonly #tools = new Map<string, ToolExecutionComponent>();
	#renderedEntryIds: number[] = [];
	#streaming: AssistantMessageComponent | undefined;
	#indicator: StatusIndicator | undefined;
	#statusText = "";
	#mountedDispose: (() => void) | undefined;

	constructor(cwd: string, handlers: TuiHandlers) {
		this.#cwd = cwd;
		this.#ui = new TuiAltScreen(new ProcessTerminal(), false, getAgentDir());
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		this.#editor = new CustomEditor(this.#ui, getEditorTheme(), keybindings, { paddingX: 1 });
		this.#editor.onSubmit = handlers.submit;
		this.#editor.onEscape = handlers.abort;
		this.#editor.onCtrlD = handlers.exit;
		this.#editor.onAction("app.clear", handlers.exit);
		this.#editor.onAction("app.model.select", handlers.selectModel);
		this.#editor.onAction("app.thinking.cycle", handlers.cycleThinking);
		this.#editor.onAction("app.message.followUp", () => {
			const text = this.#editor.getText().trim();
			if (!text) return;
			this.#editor.setText("");
			handlers.followUp(text);
		});

		this.#editorContainer.addChild(this.#editor);
		this.#footer.addChild(this.#footerStats);
		this.#footer.addChild(this.#footerHints);
		const transcript = new ScrollView(this.#chat, { follow: "end", primary: true, overscroll: "chain" });
		const dock = new VStack([
			{ component: this.#queue, shrink: 1, minSize: 0 },
			{ component: this.#notices, shrink: 1, minSize: 0 },
			{ component: this.#status, shrink: 1, minSize: 0 },
			{ component: this.#editorContainer, shrink: 1, minSize: 3 },
			{ component: this.#footer, shrink: 1, minSize: 0 },
		]);
		for (const component of [
			this.#chat,
			this.#queue,
			this.#notices,
			this.#status,
			this.#editorContainer,
			this.#footer,
		]) {
			this.#ui.addChild(component);
		}
		this.#ui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			]),
		);
		this.#ui.setFocus(this.#editor);
	}

	get ui(): TuiAltScreen {
		return this.#ui;
	}
	start(): void {
		this.#ui.start();
	}
	stop(): void {
		this.#mountedDispose?.();
		this.#indicator?.dispose();
		this.#ui.stop();
	}
	mount(component: Component, focus: Component, dispose?: () => void): void {
		this.#mountedDispose?.();
		this.#mountedDispose = dispose;
		this.#editorContainer.clear();
		this.#editorContainer.addChild(component);
		this.#ui.setFocus(focus);
		this.#ui.requestRender();
	}
	restoreEditor(): void {
		this.#mountedDispose?.();
		this.#mountedDispose = undefined;
		this.#editorContainer.clear();
		this.#editorContainer.addChild(this.#editor);
		this.#ui.setFocus(this.#editor);
		this.#ui.requestRender();
	}

	apply(view: MicroView): void {
		this.#syncTranscript(view.conversation.entries);
		if (!view.conversation.turn?.message && this.#streaming) this.#rebuildTranscript(view.conversation.entries);
		this.#syncStreaming(view.conversation.turn?.message as AssistantMessage | undefined);
		for (const slot of view.conversation.turn?.tools ?? []) {
			const component = this.#tool(slot.name, slot.callId, slot.args);
			component.setArgsComplete();
			if (slot.status === "running") component.markExecutionStarted();
			if (slot.status === "running" && slot.progress) {
				component.updateResult(
					{ content: [{ type: "text", text: slot.progress }], details: slot.details, isError: false },
					true,
				);
			}
		}
		this.#syncQueue(view);
		this.#syncNotices(view);
		this.#syncStatus(view);
		this.#syncFooter(view);
		this.#ui.requestRender();
	}

	#syncFooter(view: MicroView): void {
		const usage = view.usage;
		const stats: string[] = [];
		if (usage.input) stats.push(`↑${formatTokens(usage.input)}`);
		if (usage.output) stats.push(`↓${formatTokens(usage.output)}`);
		if (usage.cacheRead) stats.push(`R${formatTokens(usage.cacheRead)}`);
		if (usage.cacheWrite) stats.push(`W${formatTokens(usage.cacheWrite)}`);
		if (usage.lastCacheHitRate !== undefined && (usage.cacheRead > 0 || usage.cacheWrite > 0)) {
			stats.push(`CH${usage.lastCacheHitRate.toFixed(1)}%`);
		}
		stats.push(`$${usage.totalCost.toFixed(3)}`);
		if (usage.contextWindow > 0) {
			const automatic = Number(view.conversation.config.threshold ?? 0) > 0 ? " (auto)" : "";
			const context =
				usage.contextPercent === null
					? `?/${formatTokens(usage.contextWindow)}${automatic}`
					: `${usage.contextPercent.toFixed(1)}%/${formatTokens(usage.contextWindow)}${automatic}`;
			stats.push(
				usage.contextPercent !== null && usage.contextPercent > 90
					? theme.fg("error", context)
					: usage.contextPercent !== null && usage.contextPercent > 70
						? theme.fg("warning", context)
						: context,
			);
		}
		this.#footerStats.setText(theme.fg("dim", stats.join(" ")));

		const model = modelRef(view.conversation.config.model);
		const thinking = String(view.conversation.config.thinkingLevel ?? "off");
		this.#footerHints.setText(
			theme.fg(
				"dim",
				`${model ? `${model.provider}/${model.modelId}` : "no model"} · thinking:${thinking} (${keyText("app.thinking.cycle")}) · ${keyText("app.model.select")} or /model · /login · /compact · ${keyText("app.message.followUp")} follow-up · ${keyText("app.clear")} exit`,
			),
		);
	}

	#syncQueue(view: MicroView): void {
		this.#queue.clear();
		for (const queued of view.conversation.inbox) {
			const text = queued.mode === "write" ? `<${queued.entry.kind}>` : userContent(queued.input);
			this.#queue.addChild(new TruncatedText(theme.fg("muted", `[${queued.mode}] ${text}`), 1, 0));
		}
	}
	#syncNotices(view: MicroView): void {
		this.#notices.clear();
		for (const item of view.notices.slice(-4)) {
			const color = item.level === "error" ? "error" : item.level === "warning" ? "warning" : "muted";
			this.#notices.addChild(new TruncatedText(theme.fg(color, item.message), 1, 0));
		}
	}
	#syncStatus(view: MicroView): void {
		let text = "";
		const compaction = view.conversation.compaction;
		const generation = view.conversation.turn?.generation;
		const runningTool = view.conversation.turn?.tools.find((tool) => tool.status === "running");
		if (view.fatal) text = `Fatal: ${view.fatal}`;
		else if (compaction) {
			const reason = compaction.reason === "threshold" ? "automatic" : compaction.reason;
			text =
				compaction.stage === "retrying"
					? `Retrying ${reason} compaction (attempt ${compaction.attempt})...`
					: `Running ${reason} compaction...`;
		} else if (generation) {
			if (generation.stage === "retrying") text = `Retrying generation (attempt ${generation.attempt})...`;
			else if (generation.stage === "deferred") text = "Waiting for deferred response...";
			else if (generation.stage === "waiting") text = "Waiting for compaction...";
			else text = generation.stage === "streaming" ? "Working... (esc to abort)" : "Preparing response...";
		} else if (runningTool) text = `Running ${runningTool.name}... (esc to abort)`;
		if (text === this.#statusText) return;
		this.#statusText = text;
		this.#indicator?.dispose();
		this.#indicator = undefined;
		this.#status.clear();
		if (text) {
			this.#indicator = new WorkingStatusIndicator(this.#ui, text);
			this.#status.addChild(this.#indicator);
		}
	}

	#syncTranscript(entries: MicroView["conversation"]["entries"]): void {
		const diverged = this.#renderedEntryIds.some((id, index) => entries[index]?.id !== id);
		if (diverged) this.#rebuildTranscript(entries);
		for (const entry of entries.slice(this.#renderedEntryIds.length)) {
			this.#addEntry(entry);
			this.#renderedEntryIds.push(entry.id);
		}
	}
	#rebuildTranscript(entries: MicroView["conversation"]["entries"]): void {
		this.#chat.clear();
		this.#tools.clear();
		this.#renderedEntryIds = [];
		this.#streaming = undefined;
		for (const entry of entries) {
			this.#addEntry(entry);
			this.#renderedEntryIds.push(entry.id);
		}
	}
	#addEntry(entry: MicroView["conversation"]["entries"][number]): void {
		const message = entry.model?.[0];
		if (entry.kind === "pi.user" && message?.role === "user") this.#addUser(message as UserMessage);
		else if (entry.kind === "pi.assistant") {
			const assistant =
				message?.role === "assistant"
					? (message as AssistantMessage)
					: (entry.data?.display as unknown as AssistantMessage | undefined);
			if (assistant) this.#addAssistant(assistant);
		} else if (entry.kind === "pi.tool_result" && message?.role === "toolResult") {
			this.#tool(message.toolName, message.toolCallId).updateResult({
				...(message as ToolResultMessage),
				details: entry.data?.details,
			});
		} else if (entry.kind === "pi.summary") {
			this.#addText("[compaction summary]");
			if (message?.role === "user") this.#addText(userContent(message.content));
		} else if (entry.kind === "pi.notice" && message?.role === "user") this.#addText(userContent(message.content));
		else if (entry.kind === "pi.handoff") this.#addText("[handoff]");
		else if (entry.kind === "pi.reset") this.#addText("[reset]");
	}
	#addUser(message: UserMessage): void {
		this.#chat.addChild(new Spacer(1));
		this.#chat.addChild(new UserMessageComponent(userContent(message.content)));
	}
	#addAssistant(message: AssistantMessage): void {
		const component = this.#streaming ?? new AssistantMessageComponent();
		if (!this.#streaming) this.#chat.addChild(component);
		this.#streaming = undefined;
		component.updateContent(message, false);
		for (const content of message.content) {
			if (content.type === "toolCall") this.#tool(content.name, content.id, content.arguments).setArgsComplete();
		}
	}
	#syncStreaming(message: AssistantMessage | undefined): void {
		if (!message) return;
		if (!this.#streaming) {
			this.#streaming = new AssistantMessageComponent();
			this.#chat.addChild(this.#streaming);
		}
		this.#streaming.updateContent(message, true);
		for (const content of message.content) {
			if (content.type === "toolCall") this.#tool(content.name, content.id, content.arguments);
		}
	}
	#addText(text: string): void {
		this.#chat.addChild(new Spacer(1));
		this.#chat.addChild(new Text(theme.fg("muted", text), 1, 0));
	}

	static readonly #renderers: Record<string, ToolRenderers> = createAllToolRenderers();
	#tool(toolName: string, toolCallId: string, args?: unknown): ToolExecutionComponent {
		const existing = this.#tools.get(toolCallId);
		if (existing) {
			if (args !== undefined) existing.updateArgs(args);
			return existing;
		}
		const component = new ToolExecutionComponent(
			toolName,
			toolCallId,
			args ?? {},
			{},
			MicroTui.#renderers[toolName],
			this.#ui,
			this.#cwd,
		);
		this.#chat.addChild(component);
		this.#tools.set(toolCallId, component);
		return component;
	}
}

function modelRef(value: unknown): { provider: string; modelId: string } | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as { provider?: unknown; modelId?: unknown };
	return typeof candidate.provider === "string" && typeof candidate.modelId === "string"
		? { provider: candidate.provider, modelId: candidate.modelId }
		: undefined;
}

function userContent(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function authProviders(accounts: readonly MicroProviderAccount[]): AuthSelectorProvider[] {
	return accounts.map((account) => ({
		id: account.id,
		name: account.name,
		authType: account.authType,
		...(account.configured ? { status: { type: account.authType, source: account.source ?? "configured" } } : {}),
	}));
}

function showAuthNotice(dialog: LoginDialogComponent, notice: AuthEvent): void {
	if (notice.type === "auth_url") dialog.showAuth(notice.url, notice.instructions);
	else if (notice.type === "device_code") {
		dialog.showDeviceCode(notice);
		dialog.showWaiting("Waiting for authentication...");
	} else if (notice.type === "info") dialog.showInfo(notice.message, notice.links);
	else dialog.showProgress(notice.message);
}

export async function runMicroTui(source: MicroViewSource, controller: MicroController): Promise<void> {
	initTheme();
	let exit = (): void => {};
	const exited = new Promise<void>((resolve) => {
		exit = resolve;
	});
	let view!: MicroTui;

	const selectModel = (): void => {
		const snapshot = source.current();
		const current = modelRef(snapshot.conversation.config.model);
		const models = [...snapshot.models.models].sort((left, right) => {
			const leftCurrent = left.provider === current?.provider && left.modelId === current.modelId;
			const rightCurrent = right.provider === current?.provider && right.modelId === current.modelId;
			return leftCurrent === rightCurrent ? 0 : leftCurrent ? -1 : 1;
		});
		const items: SelectItem[] = models.map((model) => ({
			value: `${model.provider}/${model.modelId}`,
			label: model.modelId,
			description: model.provider,
		}));
		const selector = new ListSelector(
			"Select model:",
			items,
			(value) => {
				view.restoreEditor();
				const separator = value.indexOf("/");
				void controller.setModel({ provider: value.slice(0, separator), modelId: value.slice(separator + 1) });
			},
			() => view.restoreEditor(),
		);
		view.mount(selector, selector);
	};
	const login = (): void => {
		const accounts = source.current().models.accounts;
		const selector = new OAuthSelectorComponent(
			"login",
			authProviders(accounts),
			(providerId, authType) => {
				view.restoreEditor();
				void controller.login(providerId, authType);
			},
			() => view.restoreEditor(),
		);
		view.mount(selector, selector);
	};

	view = new MicroTui(source.current().session.cwd, {
		submit: (text) => {
			const trimmed = text.trim();
			if (!trimmed) return;
			if (trimmed === "/model") return selectModel();
			if (trimmed === "/login") return login();
			if (trimmed === "/compact") return void controller.compact();
			void (source.current().conversation.turn ? controller.steer(trimmed) : controller.prompt(trimmed));
		},
		followUp: (text) => void controller.followUp(text),
		abort: () => void controller.abort(),
		exit,
		selectModel,
		cycleThinking: () => void controller.cycleThinking(),
	});

	let authDialog: LoginDialogComponent | undefined;
	let authKey = "";
	let authNoticeCount = 0;
	let authPromptId: string | undefined;
	const syncAuth = (auth: MicroAuthView | undefined): void => {
		if (!auth) {
			if (authDialog) view.restoreEditor();
			authDialog = undefined;
			authKey = "";
			authNoticeCount = 0;
			authPromptId = undefined;
			return;
		}
		const key = `${auth.providerId}/${auth.authType}`;
		if (!authDialog || authKey !== key) {
			authKey = key;
			authNoticeCount = 0;
			authPromptId = undefined;
			authDialog = new LoginDialogComponent(
				view.ui,
				auth.providerId,
				() => void controller.cancelLogin(),
				auth.providerName,
			);
			view.mount(authDialog, authDialog);
		}
		for (const notice of auth.notices.slice(authNoticeCount)) showAuthNotice(authDialog, notice);
		authNoticeCount = auth.notices.length;
		if (!auth.prompt || auth.prompt.id === authPromptId) return;
		authPromptId = auth.prompt.id;
		const { id, request } = auth.prompt;
		if (request.type === "select") {
			const selector = new ExtensionSelectorComponent(
				request.message,
				request.options.map((option) => option.label),
				(label) => {
					view.mount(authDialog!, authDialog!);
					void controller.replyAuth(id, request.options.find((option) => option.label === label)?.id ?? null);
				},
				() => {
					view.mount(authDialog!, authDialog!);
					void controller.replyAuth(id, null);
				},
			);
			view.mount(selector, selector);
			return;
		}
		const answer: Promise<string | null> =
			request.type === "manual_code"
				? authDialog.showManualInput(request.message)
				: authDialog.showPrompt(request.message, request.placeholder);
		void answer.then(
			(value) => controller.replyAuth(id, value),
			() => controller.replyAuth(id, null),
		);
	};

	const render = (): void => {
		const snapshot = source.current();
		view.apply(snapshot);
		syncAuth(snapshot.auth);
	};
	const unsubscribe = source.subscribe(render);
	view.start();
	render();
	await exited;
	unsubscribe();
	view.stop();
}
