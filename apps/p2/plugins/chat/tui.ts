// The chat screen: coding-agent's fullscreen chat layout (chat-viewport.ts, DurableTui) over a p2 conversation.
// The transcript is incremental components in a ScrollView (pi-tui's scroll and search keys), the dock holds the
// pending area and pi's editor with the working indicator in its border. Everything the reader leaves behind is kept
// per viewed conversation, (session, conversation): references, drafts, pending send IDs and the reading position (P0c).

import { randomUUID } from "node:crypto";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import {
	type Component,
	Container,
	ScrollView,
	Text,
	TruncatedText,
	truncateToWidth,
	VStack,
} from "@earendil-works/pi-tui";
import type { Ctx, Held, HeldIn } from "@p2/app/v1";
import { BACKGROUND_CONTEXT, FileIndex, followRegistry, liveIn, serveKeyed, statusOf } from "@p2/app/v1";
import {
	BashExecutionComponent,
	buildTranscript,
	CHAT_SURFACE,
	type ChatSurfaceApi,
	CompactionStatusIndicator,
	CustomEditor,
	type EntryDisplayOf,
	FileCompletionProvider,
	type FileSource,
	type Gap,
	gapKey,
	identityKey,
	lineText,
	type MarkdownTransformer,
	ordered,
	type Pages,
	pagesWatchable,
	type ReplyTarget,
	RetryStatusIndicator,
	resolveToolRenderers,
	type StatusIndicator,
	shellAuthor,
	type ToolRendererResolver,
	type ToolRenderers,
	type ToolView,
	type Transcript,
	type TranscriptContext,
	type TranscriptStore,
	TranscriptView,
	TreeSelectorComponent,
	type TuiEntryRenderer,
	TuiEntryRenderers,
	TuiMarkdownTransformers,
	type TuiRuntime,
	TuiScope,
	type TuiSurface,
	TuiToolRendererResolvers,
	TuiToolRenderers,
	transcriptOf,
	tuiFacet,
	UserMessageSelectorComponent,
	WorkingStatusIndicator,
} from "@p2/app/v1/tui";
import { Drafts } from "../drafts/contract.ts";
import { MAX_ATTACHMENTS } from "../files/contract.ts";
import { type Session, Sessions } from "../sessions/contract.ts";
import { SessionTree } from "../tree/contract.ts";
import { Chat, type EntryDisplay, SHELL_BUSY, type ShellState, TranscriptEntries } from "./contract.ts";
import { CHAT_COMMANDS, formatSize, type LauncherUpload, registerLauncherAnswers } from "./tui-commands.ts";

/** pi: a second Ctrl+C within this window exits; a second Escape runs `doubleEscapeAction`. */
const DOUBLE_CTRL_C_MS = 500;
const DOUBLE_ESCAPE_MS = 500;

export class ChatSurface implements TuiSurface, ChatSurfaceApi {
	readonly [CHAT_SURFACE] = true as const;
	readonly runtime: TuiRuntime;
	readonly editor: CustomEditor;
	focus: CustomEditor;
	readonly transcript: TranscriptView;
	readonly scroll: ScrollView;
	private readonly pending = new Container();
	private readonly status = new Container();
	private readonly input = new Container();
	private readonly dock: VStack;
	/** The composer bar's chips (`composer:<plugin>` slots, the web's SlotList "composer"), one line under the editor. */
	private readonly chips: Component = {
		render: (width) => {
			const theme = this.runtime.theme.current;
			const files = (this.identity ? this.attachments.get(this.identity) : undefined) ?? [];
			const parts = [
				...files.map((file) => theme.fg("accent", `[${lineText(file.name)} ${formatSize(file.size)}]`)),
				...this.runtime.slots("composer:").flatMap((surface) => surface.render(width)),
			];
			return parts.length ? [truncateToWidth(` ${parts.join("  ")}`, width)] : [];
		},
		invalidate: () => {},
	};
	/** Replies exist while a plugin allows them (chat-mode, in chat mode), as the web's `canReply`. */
	canReply = false;
	/** The agent's name to mention while chat mode is on (chat-mode's setting), offered first as `@name`. */
	mentionName = "Pi";
	/** The message the next send answers. */
	replyTo: { entryId: number; name: string } | undefined;
	private readonly readOnly = new Text("", 1, 0);
	private scope: TuiScope | undefined;
	private sessions: TuiScope;
	/** The viewed identity, `identityKey(session, conversation)`. */
	private identity: string | undefined;
	private session: string | undefined;
	private conversation = 1;
	private rows: readonly Session[] = [];
	/** Where the viewed conversation works (its agent's cwd: a subagent's own, else the session's). */
	private get cwd(): string {
		const agent = this.view?.docs["pi.agent"] as { cwd?: unknown } | undefined;
		return typeof agent?.cwd === "string" ? agent.cwd : (this.rows.find((row) => row.id === this.session)?.cwd ?? "");
	}
	private ref: (() => Held<typeof Chat>) | undefined;
	private view: ConversationView | null | undefined;
	/** The conversation's user shell command while it runs (`Chat.liveShell`), and its component (the transcript tail). */
	private liveShell: ShellState = null;
	private shellView: { id: string; component: BashExecutionComponent } | undefined;
	/**
	 * The conversation's transcript (src/web/history.ts): entries that leave the view's window stay. Kept with the
	 * lingering Chat reference, so switching back to a conversation finds its pages loaded.
	 */
	private transcriptStore: TranscriptStore | undefined;
	private get pages(): Pages | undefined {
		return this.transcriptStore?.value;
	}
	/** Transcripts whose earlier page failed to load: reaching the top again does not ask again. */
	private readonly earlierFailed = new WeakSet<TranscriptStore>();
	/** Gaps whose entries failed to load: showing them again does not ask again. */
	private readonly gapsFailed = new WeakSet<Gap>();
	private current: Transcript | undefined;
	private synced: unknown[] = [];
	private disposed = false;
	private sending = false;
	/** A send asked for while the conversation was connecting. */
	private waiting: "steer" | "followUp" | undefined;
	private lastCtrlC = 0;
	private lastEscape = 0;
	private indicator: StatusIndicator | undefined;
	private indicatorKey = "";
	private toolRenderers: ReadonlyMap<string, ToolRenderers> = new Map();
	private resolvers: ReadonlyMap<string, ToolRendererResolver> = new Map();
	private entryRenderers: ReadonlyMap<string, TuiEntryRenderer> = new Map();
	private transformers: MarkdownTransformer[] = [];
	private displays: ReadonlyMap<string, (data: unknown) => EntryDisplay | undefined> = new Map();
	private readonly display: EntryDisplayOf = (kind, data) => this.displays.get(kind)?.(data);
	private stops: (() => void)[] = [];

	constructor(runtime: TuiRuntime) {
		this.runtime = runtime;
		const surface = this;
		const ctx: TranscriptContext = {
			get theme() {
				return runtime.theme;
			},
			keyText: (id) => runtime.ctx.keyText(id),
			requestRender: () => runtime.tui.requestRender(),
			get cwd() {
				return surface.cwd;
			},
			get markdownTransformers() {
				return surface.transformers;
			},
			get settings() {
				return runtime.ctx.settings;
			},
			toolRenderers: (name) =>
				resolveToolRenderers(name, surface.resolvers, surface.toolRenderers, runtime.ctx.settings),
			get entryRenderers() {
				return surface.entryRenderers;
			},
		};
		this.transcript = new TranscriptView(
			ctx,
			{ expanded: runtime.expandedTools, showThinking: runtime.showThinking },
			{ render: (width) => runtime.header.render(width), invalidate: () => runtime.header.invalidate() },
		);
		this.scroll = new ScrollView(this.transcript, {
			follow: "end",
			primary: true,
			overscroll: "chain",
			scrollbar: "auto",
			scrollbarTrackStyle: (text) => runtime.theme.current.fg("scrollbarTrack", text),
			scrollbarThumbStyle: (text) => runtime.theme.current.fg("scrollbarThumb", text),
		});
		this.transcript.attach(this.scroll);
		this.transcript.onTop = () => this.loadEarlier();
		this.transcript.onVisibleGap = (item) => this.fillGap(item.gap);
		this.transcript.onMissingAnchor = (anchor) => {
			// A position in older history: page towards it while there is more.
			const items = this.pages?.view.items ?? [];
			const oldest = items.find((item) => item.kind === "entry");
			const older = oldest === undefined || (anchor.entryId ?? 0) < oldest.entry.id;
			if (anchor.entryId === undefined || items[0]?.kind !== "earlier" || !older)
				return this.pages?.loadingEarlier === true;
			this.loadEarlier();
			return true;
		};
		this.editor = new CustomEditor(runtime.tui, runtime.ctx, { paddingX: 1 });
		this.focus = this.editor;
		this.editor.onChange = () => {
			if (this.identity) runtime.drafts.set(this.identity, this.editor.getExpandedText());
			this.syncBorder();
		};
		this.editor.setAutocompleteProvider(
			new FileCompletionProvider(
				runtime.ctx.commands.autocomplete,
				() => this.fileSource(),
				(text) => {
					if (runtime.notices.at(-1)?.text !== text) runtime.notify(text);
				},
				// Chat mode: `@pi` (or the agent's name there) mentions the agent; offered first while chat mode is on.
				() => (this.canReply ? this.mentionName : undefined),
			),
		);
		// Editor clears before onSubmit: restore until admission succeeds, including failed/offline sends.
		this.editor.onSubmit = (text) => {
			// pi's bash mode: `!cmd` runs a command whose output joins the context, `!!cmd` one that stays out of it.
			const bang = /^\s*(!!?)\s*([\s\S]*)$/.exec(text);
			if (bang?.[2]?.trim()) {
				this.editor.setText(text);
				this.shell(bang[2].trim(), bang[1] === "!");
				return;
			}
			if (text.trimStart().startsWith("/")) {
				if (runtime.ctx.commands.runSlash(text)) return;
				// A known command that does not apply here (not connected yet, a guest, ...) is not sent as a message.
				const name = /^\/(\S+)/.exec(text.trimStart())?.[1];
				if (name && runtime.ctx.commands.list().some((item) => item.slash === name)) {
					this.editor.setText(text);
					runtime.notify(`/${name} is not available here`, "warning");
					return;
				}
				// A prompt template or /skill: (10.8) is expanded on the session worker, then sent as pi does.
				if (name && runtime.ctx.commands.expandable(name)) {
					this.editor.setText(text);
					void runtime.ctx.commands.expand(text.trimStart()).then((expanded) => {
						if (this.editor.getText() === text) this.editor.setText(expanded);
						this.send("steer");
					});
					return;
				}
			}
			this.editor.setText(text);
			this.send("steer");
		};
		this.input.addChild(this.editor);
		this.dock = new VStack([
			{ component: this.pending, shrink: 1, minSize: 0 },
			{ component: this.status, shrink: 1, minSize: 0 },
			{ component: this.input, shrink: 1, minSize: 1 },
			{ component: this.chips, shrink: 1, minSize: 0 },
		]);
		const registries = runtime.host;
		this.stops.push(
			followRegistry(registries, TuiToolRenderers, (table) => {
				this.toolRenderers = table;
				this.renderersChanged();
			}),
			followRegistry(registries, TuiToolRendererResolvers, (table) => {
				this.resolvers = table;
				this.renderersChanged();
			}),
			followRegistry(registries, TuiEntryRenderers, (table) => {
				this.entryRenderers = table;
				this.renderersChanged();
			}),
			followRegistry(registries, TuiMarkdownTransformers, (table) => {
				this.transformers = ordered(table);
				this.renderersChanged();
			}),
			followRegistry(registries, TranscriptEntries, (table) => {
				this.displays = table;
				this.renderersChanged();
			}),
		);
		// The session's cwd: tool paths display relative to it.
		this.sessions = new TuiScope(runtime);
		this.sessions.watch(Sessions, {}, (ref, follow) => {
			const viewer = liveIn(ref, "owner", "guest");
			if (viewer)
				follow(viewer.sessions, (rows) => {
					this.rows = rows;
				});
		});
		// Resolvers read plugin settings (`ToolRendererResolver`): a change there draws every card again.
		let pluginSettings = JSON.stringify(runtime.ctx.settings.plugins ?? {});
		const changed = (): void => {
			const next = JSON.stringify(runtime.ctx.settings.plugins ?? {});
			if (next !== pluginSettings) {
				pluginSettings = next;
				this.renderersChanged();
			}
			this.update();
		};
		runtime.listeners.add(changed);
		this.stops.push(() => runtime.listeners.delete(changed));
		// What the launcher may ask for under a grant (P5: Ctrl+X copy, Ctrl+G external editor).
		this.stops.push(registerLauncherAnswers(this));
		this.update();
	}

	/** Renderer contributions changed (facet reload): rebuild every component with the new tables. */
	private renderersChanged(): void {
		this.transcript.reset();
		this.synced = [];
		this.sync();
		this.runtime.tui.requestRender();
	}

	layout(): { body: Component; dock: Component } {
		return { body: this.scroll, dock: this.dock };
	}

	/** Keeps the reading position of the viewed conversation in the runtime (identity switches and reloads). */
	saveState(): void {
		if (!this.identity) return;
		const anchor = this.transcript.anchor();
		if (anchor) this.runtime.anchors.set(this.identity, anchor);
		else this.runtime.anchors.delete(this.identity);
	}

	/** Runtime state changed: switch identity if needed, then sync transcript, dock and indicator. */
	private update(): void {
		const runtime = this.runtime;
		const identity = runtime.identity;
		if (identity !== this.identity) this.switchTo(identity);
		this.transcript.setState({ expanded: runtime.expandedTools, showThinking: runtime.showThinking });
		this.sync();
		if (this.waiting && runtime.connected && this.participant()) this.send(this.waiting);
	}

	private switchTo(identity: string | undefined): void {
		const runtime = this.runtime;
		this.saveState();
		this.scope?.dispose();
		this.scope = undefined;
		this.ref = undefined;
		this.view = undefined;
		this.transcriptStore = undefined;
		this.files = undefined;
		this.current = undefined;
		this.liveShell = null;
		this.synced = [];
		this.sending = false;
		this.waiting = undefined;
		this.replyTo = undefined;
		this.transcript.reset();
		this.identity = identity;
		this.session = runtime.session;
		this.conversation = runtime.conversation;
		this.editor.setText(identity ? (runtime.drafts.get(identity) ?? "") : "");
		this.transcript.restore(identity ? runtime.anchors.get(identity) : undefined);
		if (!identity || !this.session) return;
		const session = this.session;
		const conversation = this.conversation;
		const scope = new TuiScope(runtime);
		this.scope = scope;
		this.ref = scope.watch(Chat, { session, conversation }, (ref, follow) => {
			follow(ref.view, (view) => {
				if (view !== undefined) this.view = view;
			});
			follow(ref.liveShell, (shell) => {
				this.liveShell = shell ?? null;
			});
			// Every view is merged into the transcript; it is released with the reference.
			const store = transcriptOf(runtime.host, identityKey(session, conversation), {
				view: ref.view,
				entries: (query) => ref.entries(query, BACKGROUND_CONTEXT),
			});
			this.transcriptStore = store;
			follow(pagesWatchable(store), () => {});
			if (ref.variant !== "participant") return;
			scope.watch(Drafts, { session, conversation }, (drafts, subscribe) => {
				subscribe(drafts.drafts, (items) => {
					if (items?.length)
						runtime.perform(
							drafts
								.claim({ ids: items.map((item) => item.id) }, BACKGROUND_CONTEXT)
								.then(({ texts }) => this.restore(identityKey(session, conversation), texts)),
						);
				});
			});
			// `@` and Tab file completion (participants, as the workspace); a server without the plugin has none.
			if (!this.files)
				try {
					this.files = scope.watch(FileIndex, { session, conversation }, () => {});
				} catch {}
		});
	}

	/** The viewed conversation's file index once live (P7b). */
	private files: (() => Held<typeof FileIndex>) | undefined;
	private fileSource(): FileSource | undefined {
		const ref = liveIn(this.files?.(), "reader");
		return (
			ref && {
				complete: (args) => ref.complete(args, BACKGROUND_CONTEXT),
				list: (args) => ref.list(args, BACKGROUND_CONTEXT),
			}
		);
	}

	/** Finished calls of a tool in the loaded transcript, oldest first (`/downloads` lists send_file's). */
	toolViews(name: string): ToolView[] {
		return (this.current?.items ?? []).flatMap((item) =>
			(item.type === "assistant" ? item.tools : item.type === "tool" ? [item.tool] : []).filter(
				(tool) => tool.name === name && tool.status === "done",
			),
		);
	}

	/** The latest answer's text (pi's /copy and Ctrl+X): the last assistant message's text parts. */
	/** Uploaded attachments (P9) waiting for the next send, by identity; added only by the launcher's uploads. */
	readonly attachments = new Map<string, LauncherUpload[]>();
	addAttachment(file: LauncherUpload): boolean {
		if (!this.identity || !this.participant()) return false;
		const list = this.attachments.get(this.identity) ?? [];
		if (list.length >= MAX_ATTACHMENTS || list.some((entry) => entry.id === file.id)) return false;
		this.attachments.set(this.identity, [...list, file]);
		this.runtime.changed();
		return true;
	}
	/** Removes the last attachment, or all of them. */
	detach(all = false): void {
		if (!this.identity) return;
		const list = this.attachments.get(this.identity) ?? [];
		this.attachments.set(this.identity, all ? [] : list.slice(0, -1));
		this.runtime.changed();
	}
	lastAssistantText(): string | undefined {
		const item = this.current?.items.findLast((entry) => entry.type === "assistant" && !entry.streaming);
		if (item?.type !== "assistant") return undefined;
		const text = item.message.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n\n")
			.trim();
		return text || undefined;
	}
	/** Whether this visitor can edit the editor here (a live participant). */
	get editable(): boolean {
		return this.participant() !== undefined;
	}

	private participant(): HeldIn<typeof Chat, "participant"> | undefined {
		const ref = this.ref?.();
		return liveIn(ref, "participant");
	}

	private sync(): void {
		const ref = this.ref?.();
		const view = this.view;
		const pages = this.pages;
		const inputs = [pages, this.displays, this.toolRenderers, this.resolvers, this.entryRenderers];
		if (inputs.length !== this.synced.length || inputs.some((input, index) => input !== this.synced[index])) {
			this.synced = inputs;
			this.current = pages ? buildTranscript(pages.view, this.display, pages.filling) : undefined;
			const entries = (pages?.view.items ?? []).flatMap((item) => (item.kind === "entry" ? [item.entry] : []));
			this.transcript.sync(this.current, entries);
		}
		this.transcript.empty = !this.session
			? "No session selected."
			: view === undefined
				? "Loading conversation…"
				: view === null
					? "This conversation is not available."
					: "";
		const theme = this.runtime.theme;
		const participant = this.participant() !== undefined;
		this.syncBorder();
		this.syncShell();
		this.syncPending(participant);
		this.syncIndicator(participant);
		this.input.clear();
		if (participant) this.input.addChild(this.editor);
		else {
			this.readOnly.setText(
				theme.current.fg(
					"muted",
					!this.session
						? `${this.runtime.ctx.keyText("p2.sessions") || "/sessions"} to choose a session`
						: ref !== undefined && statusOf(ref) === "live"
							? // The web's read-only bar: a view-only guest sees under which name it joined.
								this.runtime.role === "guest" && this.runtime.grant
								? `Joined as ${lineText(this.runtime.grant.name).slice(0, 40)} (unverified) · read-only`
								: "Read-only conversation"
							: "Connecting conversation…",
				),
			);
			this.input.addChild(this.readOnly);
		}
	}

	/** pi: the thinking level's border color, or the bash mode color while the text starts with `!`. */
	private syncBorder(): void {
		const theme = this.runtime.theme;
		const level = this.current?.agent.thinkingLevel ?? "off";
		const bash = this.participant() !== undefined && this.editor.getText().trimStart().startsWith("!");
		this.editor.borderColor = (text) =>
			bash ? theme.current.getBashModeBorderColor()(text) : theme.current.getThinkingBorderColor(level)(text);
	}

	/** The running command as pi's bash execution component at the end of the transcript. */
	private syncShell(): void {
		const live = this.liveShell;
		if (!live) {
			this.shellView?.component.dispose();
			this.shellView = undefined;
			this.transcript.tail = undefined;
			return;
		}
		if (this.shellView?.id !== live.id) {
			this.shellView?.component.dispose();
			const component = new BashExecutionComponent(live.command, this.runtime.ctx, {
				excludeFromContext: !live.includeInContext,
				by: shellAuthor(live.author),
				...(live.running ? { tui: this.runtime.tui } : {}),
			});
			this.shellView = { id: live.id, component };
		}
		const component = this.shellView.component;
		component.setExpanded(this.runtime.expandedTools);
		component.setOutput(live.output, live.truncated);
		if (!live.running)
			component.setComplete(live.exitCode, live.cancelled, {
				truncated: live.truncated,
				...(live.error === undefined ? {} : { error: live.error }),
			});
		this.transcript.tail = component;
	}

	/** `!cmd`/`!!cmd`: runs the command (`Chat.shell`); one at a time, as pi. */
	shell(command: string, includeInContext: boolean): void {
		const ref = this.participant();
		const identity = this.identity;
		if (!ref || !identity) {
			this.runtime.fail(
				this.ref?.() !== undefined && statusOf(this.ref()) === "live"
					? "This conversation is read-only"
					: "Not connected yet",
			);
			return;
		}
		if (this.liveShell?.running) {
			this.runtime.notify(SHELL_BUSY, "warning");
			return;
		}
		const draft = this.editor.getExpandedText();
		this.runtime.clearNotices();
		this.scroll.scrollToEnd();
		this.runtime.perform(
			ref.shell({ command, includeInContext, requestId: randomUUID() }, BACKGROUND_CONTEXT).then(() => {
				if (!this.disposed) this.editor.addToHistory(draft.trim());
				if (!this.disposed && identity === this.identity && this.editor.getExpandedText() === draft)
					this.editor.setText("");
				if (this.runtime.drafts.get(identity) === draft) this.runtime.drafts.set(identity, "");
				this.runtime.changed();
			}),
		);
	}

	/** Queued inputs (coding-agent's pending messages area). */
	private syncPending(participant: boolean): void {
		const theme = this.runtime.theme.current;
		this.pending.clear();
		const queued = this.current?.queued ?? [];
		const replying = this.canReply ? this.replyTo : undefined;
		if (queued.length === 0 && !this.sending && !this.waiting && !replying) return;
		this.pending.addChild(new Text("", 0, 0));
		if (replying)
			this.pending.addChild(
				new TruncatedText(theme.fg("accent", `↪ Replying to ${lineText(replying.name)} · /reply cancels`), 1, 0),
			);
		for (const input of queued)
			this.pending.addChild(
				new TruncatedText(
					theme.fg("dim", `${input.mode === "followUp" ? "Follow-up" : "Steering"}: ${lineText(input.text)}`),
					1,
					0,
				),
			);
		if (queued.length && participant) {
			const hint = this.runtime.ctx.keyText("app.message.dequeue");
			if (hint)
				this.pending.addChild(new TruncatedText(theme.fg("dim", `↳ ${hint} to edit your queued messages`), 1, 0));
		}
		if (this.sending || this.waiting)
			this.pending.addChild(
				new TruncatedText(theme.fg("dim", this.sending ? "Sending…" : "Sending when connected…"), 1, 0),
			);
	}

	/** DTUI `#syncStatus`: retry, compaction, running tool or working, from `pi.live`. */
	private syncIndicator(participant: boolean): void {
		const ctx = this.runtime.ctx;
		const tui = this.runtime.tui;
		const live = this.view?.docs["pi.live"] as unknown as LiveState | undefined;
		const generation = live?.generation;
		const compaction = live?.compactions?.[0];
		const running = live?.tools?.find((slot) => slot.status === "running");
		const abort = `(${ctx.keyText("app.interrupt")} to abort)`;
		let key = "";
		let create: (() => StatusIndicator) | undefined;
		if (generation?.retry !== undefined) {
			const retry = generation.retry;
			key = `retry:${generation.attempt}:${retry.at}`;
			create = () => new RetryStatusIndicator(tui, ctx, generation.attempt, retry.at, lineText(retry.error));
		} else if (generation?.deferred !== undefined) {
			key = "deferred";
			create = () => new WorkingStatusIndicator(tui, ctx, "Waiting for deferred response...");
		} else if (compaction !== undefined) {
			key = `compaction:${compaction.trigger}:${compaction.retry ? compaction.attempt : ""}`;
			create = () =>
				new CompactionStatusIndicator(
					tui,
					ctx,
					compaction.trigger,
					compaction.retry ? compaction.attempt : undefined,
				);
		} else if (running !== undefined) {
			key = `tool:${running.name}`;
			create = () => new WorkingStatusIndicator(tui, ctx, `Running ${lineText(running.name)}... ${abort}`);
		} else if (live?.run !== undefined) {
			key = "working";
			create = () => new WorkingStatusIndicator(tui, ctx, `Working... ${abort}`);
		}
		key = `${key}:${participant}`;
		if (key !== this.indicatorKey) {
			this.indicatorKey = key;
			this.indicator?.dispose();
			this.indicator = create?.();
		}
		this.editor.setWorkingStatusIndicator(participant ? this.indicator : undefined);
		this.status.clear();
		// Viewers have no editor border: the indicator gets its own line.
		if (!participant && this.indicator) this.status.addChild(this.indicator);
	}

	send(mode: "steer" | "followUp"): void {
		const ref = this.participant();
		const text = this.editor.getExpandedText().trim();
		const files = this.identity ? (this.attachments.get(this.identity) ?? []) : [];
		if ((!text && !files.length) || this.sending) return;
		const current = this.ref?.();
		if (current !== undefined && statusOf(current) === "live" && current.variant !== "participant") {
			this.runtime.fail("This conversation is read-only");
			return;
		}
		if (!this.runtime.connected || !ref) {
			// Still connecting (a reload, a reconnect): sent once the conversation is live, with the same request ID.
			this.waiting = mode;
			this.runtime.changed();
			return;
		}
		this.waiting = undefined;
		const identity = this.identity!;
		const draft = this.editor.getExpandedText();
		let submission = this.runtime.submissions.get(identity);
		if (submission?.text !== text || submission.mode !== mode) {
			submission = { text, mode, id: randomUUID() };
			this.runtime.submissions.set(identity, submission);
		}
		this.sending = true;
		this.runtime.clearNotices();
		this.scroll.scrollToEnd();
		this.runtime.perform(
			ref
				.send(
					{
						text,
						requestId: submission.id,
						whenBusy: mode,
						...(files.length ? { attachments: files.map((file) => file.id) } : {}),
						...(this.canReply && this.replyTo ? { replyTo: this.replyTo.entryId } : {}),
					},
					BACKGROUND_CONTEXT,
				)
				.then(() => {
					// Sent: these attachments belong to the message now (later uploads stay pending).
					const left = (this.attachments.get(identity) ?? []).filter((file) => !files.includes(file));
					this.attachments.set(identity, left);
					if (identity === this.identity) this.replyTo = undefined;
					if (!this.disposed) this.editor.addToHistory(text);
					if (!this.disposed && identity === this.identity && this.editor.getExpandedText() === draft)
						this.editor.setText("");
					if (this.runtime.drafts.get(identity) === draft) this.runtime.drafts.set(identity, "");
					if (this.runtime.submissions.get(identity) === submission) this.runtime.submissions.delete(identity);
				})
				.finally(() => {
					if (identity === this.identity) this.sending = false;
					this.runtime.changed();
				}),
		);
	}

	private restore(identity: string, texts: string[]): void {
		if (!texts.length) return;
		const draft = [...texts, this.runtime.drafts.get(identity) ?? ""].filter(Boolean).join("\n\n");
		this.runtime.drafts.set(identity, draft);
		if (!this.disposed && this.identity === identity) this.editor.setText(draft);
		this.runtime.changed();
	}

	private loadEarlier(): void {
		const ref = this.ref?.();
		const store = this.transcriptStore;
		if (ref === undefined || statusOf(ref) !== "live" || !store || this.earlierFailed.has(store)) return;
		this.runtime.perform(
			(async () => {
				try {
					await store.loadEarlier();
				} catch (error) {
					// No retry loop from the top of the transcript: scrolling there again does not ask again.
					this.earlierFailed.add(store);
					throw error;
				} finally {
					this.runtime.changed();
				}
			})(),
		);
	}

	/** Loads a gap's missing entries while it is in view; a failed load is not retried for that gap. */
	private fillGap(gap: Gap): void {
		const ref = this.ref?.();
		const store = this.transcriptStore;
		if (
			ref === undefined ||
			statusOf(ref) !== "live" ||
			!store ||
			this.gapsFailed.has(gap) ||
			store.value?.filling.has(gapKey(gap))
		)
			return;
		this.runtime.perform(
			(async () => {
				try {
					await store.fillGap(gap);
				} catch (error) {
					this.gapsFailed.add(gap);
					throw error;
				} finally {
					this.runtime.changed();
				}
			})(),
		);
	}

	/**
	 * `app.interrupt` (pi's Escape): aborts a running compaction and stops the generation; the caller's own queued
	 * texts come back to the editor.
	 */
	interrupt(): void {
		const ref = this.participant();
		const identity = this.identity;
		if (!ref || !identity) return;
		const live = this.view?.docs["pi.live"] as unknown as LiveState | undefined;
		const shell = this.liveShell;
		// pi's order: a running agent, a running command, bash mode's text, then the double Escape on an empty editor.
		if (!live?.run && !live?.compactions?.length) {
			if (shell?.running) {
				this.runtime.perform(ref.abortShell({ shellId: shell.id }, BACKGROUND_CONTEXT));
				return;
			}
			if (this.editor.getText().trimStart().startsWith("!")) {
				this.editor.setText("");
				this.runtime.drafts.set(identity, "");
				this.syncBorder();
				return;
			}
			if (!this.editor.getText().trim()) this.doubleEscape();
		}
		if (live?.compactions?.length) this.runtime.perform(ref.abortCompaction(BACKGROUND_CONTEXT));
		if (live?.run || !live?.compactions?.length)
			this.runtime.perform(ref.stop(BACKGROUND_CONTEXT).then(({ restored }) => this.restore(identity, restored)));
	}

	/** pi's `doubleEscapeAction` (default "tree"): "tree" opens `/tree`, "fork" `/fork`'s picker. */
	private doubleEscape(): void {
		const action = this.runtime.ctx.settings.doubleEscapeAction ?? "tree";
		if (action === "none" || this.runtime.role !== "owner") return;
		const now = Date.now();
		if (now - this.lastEscape < DOUBLE_ESCAPE_MS) {
			this.lastEscape = 0;
			if (action === "fork") this.openFork();
			else this.openTree();
		} else this.lastEscape = now;
	}

	/**
	 * pi's `/tree` (docs/tree.md): the session's branches as one tree; Enter continues the session at the chosen
	 * message (`SessionTree.navigate`), a user message waiting in the editor of the conversation it switched to. The
	 * label key renames the selected message's branch (`SessionTree.rename`); a null label shows the session title.
	 */
	openTree(): void {
		const runtime = this.runtime;
		const session = this.session;
		if (!session) return;
		const title = () => this.rows.find((row) => row.id === session)?.title ?? "";
		runtime.perform(
			runtime.host.root(async (root) => {
				const ref = await root.get(SessionTree, { session });
				if (ref.variant !== "owner") throw new Error("Only the owner switches branches");
				const tree = await ref.tree(root);
				// Each action runs in a root of its own: the selector outlives this one.
				const act = (action: (tree: typeof ref, ctx: Ctx) => Promise<void>) =>
					runtime.perform(
						runtime.host.root(async (inner) => {
							const owned = await inner.get(SessionTree, { session });
							if (owned.variant !== "owner") throw new Error("Only the owner switches branches");
							await action(owned, inner);
						}, BACKGROUND_CONTEXT),
					);
				const selector: TreeSelectorComponent = new TreeSelectorComponent(
					runtime.ctx,
					tree.nodes,
					tree.current,
					new Map(tree.branches.map((branch) => [branch.conversation, branch.label ?? title()])),
					(entry) => {
						overlay.close();
						act(async (owned, ctx) => {
							const { conversation, text } = await owned.navigate({ entry }, ctx);
							const identity = identityKey(session, conversation);
							if (text !== null) runtime.drafts.set(identity, text);
							runtime.navigate("chat", session, conversation);
							// Already shown (the session continues in the same conversation): the editor takes the text now.
							if (text !== null && !this.disposed && this.identity === identity) this.editor.setText(text);
						});
					},
					() => overlay.close(),
					(conversation, label) =>
						act(async (owned, ctx) => {
							await owned.rename({ conversation, label: label || null }, ctx);
							selector.setLabel(conversation, label || title());
						}),
				);
				const overlay = runtime.ctx.overlay("tree", selector, { width: "100%", anchor: "bottom-center" });
			}, BACKGROUND_CONTEXT),
		);
	}

	/**
	 * pi's `/fork`: pick a person's message of the loaded transcript; a new session holds what came before it and the
	 * message waits in its editor (`Sessions.fork`). The main conversation only.
	 */
	openFork(): void {
		const runtime = this.runtime;
		const session = this.session;
		if (!session) return;
		if (this.conversation !== runtime.mainOf(session)) {
			runtime.notify("Forking a subagent conversation is not supported yet", "warning");
			return;
		}
		const messages = (this.current?.items ?? []).flatMap((item) =>
			item.type === "user" && item.entryId !== undefined && item.text.trim()
				? [{ id: item.entryId, text: item.text }]
				: [],
		);
		if (!messages.length) {
			runtime.notify("No messages to fork from");
			return;
		}
		const overlay = runtime.ctx.overlay(
			"fork",
			new UserMessageSelectorComponent(
				runtime.ctx,
				messages,
				(id) => {
					overlay.close();
					const text = messages.find((message) => message.id === id)?.text ?? "";
					runtime.perform(
						runtime.host.root(async (root) => {
							const sessions = await root.get(Sessions, {});
							if (sessions.variant !== "owner") throw new Error("Only the owner forks sessions");
							const created = await sessions.fork(
								{ id: session, conversation: this.conversation, before: id },
								root,
							);
							runtime.drafts.set(identityKey(created.id, 1), text);
							runtime.navigate("chat", created.id, 1);
							runtime.notify("Forked to new session");
						}, BACKGROUND_CONTEXT),
					);
				},
				() => overlay.close(),
				messages.at(-1)?.id,
			),
			{ width: "100%", anchor: "bottom-center" },
		);
	}

	/** pi's `/clone`: the whole session as a new one (`Sessions.clone`), opened. */
	cloneSession(): void {
		const runtime = this.runtime;
		const session = this.session;
		if (!session) return;
		runtime.perform(
			runtime.host.root(async (root) => {
				const sessions = await root.get(Sessions, {});
				if (sessions.variant !== "owner") throw new Error("Only the owner clones sessions");
				const created = await sessions.clone({ id: session }, root);
				runtime.navigate("chat", created.id, 1);
				runtime.notify("Cloned to new session");
			}, BACKGROUND_CONTEXT),
		);
	}

	/** `/compact [instructions]`: summarize earlier context now (Escape aborts it). */
	compact(instructions?: string): void {
		const ref = this.participant();
		if (!ref) return;
		this.runtime.perform(
			ref.compact(instructions?.trim() ? { instructions: instructions.trim() } : {}, BACKGROUND_CONTEXT),
		);
	}

	/** `/new-context [handoff]`: a new context, starting with the handoff text when given (owner). */
	newContext(handoff?: string): void {
		const ref = this.participant();
		if (!ref) return;
		this.runtime.perform(
			ref
				.reset(handoff?.trim() ? { handoff: handoff.trim() } : {}, BACKGROUND_CONTEXT)
				.then(() => this.runtime.notify("Started a new context")),
		);
	}

	/** `app.clear` (pi's Ctrl+C): clears the editor; a second press within 500 ms exits. */
	clear(): void {
		const now = Date.now();
		if (now - this.lastCtrlC < DOUBLE_CTRL_C_MS) {
			this.lastCtrlC = 0;
			this.runtime.onExit();
			return;
		}
		this.lastCtrlC = now;
		this.editor.setText("");
		if (this.identity) this.runtime.drafts.set(this.identity, "");
	}

	/**
	 * `app.message.dequeue` (pi's Alt+Up): every queued input of the caller back to the editor, in order, before the
	 * current text; other people's stay queued (`Chat.dequeueOwn`).
	 */
	dequeueOwn(): void {
		const ref = this.participant();
		const identity = this.identity;
		if (!ref || !identity) return;
		this.runtime.perform(
			ref.dequeueOwn(BACKGROUND_CONTEXT).then(({ restored, skipped }) => {
				this.restore(identity, restored);
				if (skipped)
					this.runtime.notify(
						`${skipped} queued message${skipped === 1 ? " was" : "s were"} already sent`,
						"warning",
					);
				else if (!restored.length) this.runtime.notify("No queued messages of yours");
			}),
		);
	}

	/** Chat mode switched replies on or off (chat-mode's composer chip). */
	setCanReply(enabled: boolean, mentionName = "Pi"): void {
		if (enabled === this.canReply && mentionName === this.mentionName) return;
		this.canReply = enabled;
		this.mentionName = mentionName;
		if (!enabled) this.replyTo = undefined;
		this.runtime.changed();
	}

	/** The next send answers this entry (chat mode); undefined cancels. */
	setReplyTo(target: { entryId: number; name: string } | undefined): void {
		this.replyTo = target;
		this.runtime.changed();
	}

	/** Messages a reply can answer: people's and Pi's committed messages, newest first. */
	replyTargets(): ReplyTarget[] {
		return (this.current?.items ?? [])
			.flatMap((item) =>
				item.type === "user" && item.entryId !== undefined
					? [{ entryId: item.entryId, name: item.author?.name ?? item.peer?.title ?? "You", excerpt: item.text }]
					: item.type === "assistant" && item.entryId !== undefined
						? [
								{
									entryId: item.entryId,
									name: "Pi",
									excerpt: item.message.content
										.flatMap((part) => (part.type === "text" ? [part.text] : []))
										.join(" "),
								},
							]
						: [],
			)
			.toReversed()
			.slice(0, 50);
	}

	/** Context terms for command `when` expressions (section 6.3). */
	*contexts(): Iterable<string> {
		if (this.current?.working) yield "busy";
		if (this.current?.compactions.length) yield "compacting";
		if (!this.participant()) return;
		yield "participant";
		yield "editorFocused";
		if (!this.editor.getText()) yield "editorEmpty";
		if (this.editor.isShowingAutocomplete()) yield "autocomplete";
		if (this.canReply) yield "canReply";
		if (this.identity && this.attachments.get(this.identity)?.length) yield "attachments";
	}

	/** The editor keeps input while the conversation connects (a reload, a reconnect); read-only views drop it. */
	handleInput(data: string): void {
		const ref = this.ref?.();
		if (ref !== undefined && statusOf(ref) === "live" && ref.variant !== "participant") return;
		this.editor.handleInput(data);
	}

	/** Without the fullscreen layout (tests): transcript, dock. */
	render(width: number): string[] {
		return [...this.transcript.render(width), ...this.dock.render(width)];
	}

	invalidate(): void {
		this.transcript.invalidate();
		this.editor.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.saveState();
		for (const stop of this.stops.splice(0)) stop();
		this.indicator?.dispose();
		this.shellView?.component.dispose();
		this.transcript.dispose();
		this.sessions.dispose();
		this.scope?.dispose();
	}
}

// The chat plugin defines the transcript's entry displays (chat-mode adds its own): served on the TUI too.
export default tuiFacet(
	"chat",
	(runtime) => new ChatSurface(runtime),
	CHAT_COMMANDS,
	(host) => serveKeyed(host, TranscriptEntries),
);
