// The sessions screen: pi's `/resume` session selector (coding-agent interactive/components/session-selector.ts) on
// p2's data, with the adaptations of p2-tui-port.md section 1.17:
// - one line per session (title, env:cwd in the "all" scope, age); Tab switches the current env:cwd / all sessions;
// - local fuzzy filtering over title, env:cwd and ID; message hits come from `Search` (owner), in a separate
//   "Messages" group of literal matches; pi's phrases and `re:` are unsupported (the hint says so);
// - sorts: threaded (sessions with their subagent conversations nested, `Subagents`), recent, relevance;
// - pi's named filter is a pinned filter; delete means archive (confirmed), restored from the archived scope (Ctrl+A);
// - rename and pin (owner). Selecting a subagent opens its conversation: the (session, conversation) identity.
// `+ New session` asks for a working directory, Tab choosing the environment; `/new [env:]path` creates one directly;
// `/cd [env:]path` relocates the viewed session (the web's Relocate); `/name`, `/session` live here and in the status
// plugin.

import {
	type Component,
	type Focusable,
	fuzzyFilter,
	Input,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Held } from "@p2/app/v1";
import { BACKGROUND_CONTEXT, contribute, defineFacet, followRegistry, liveIn, statusOf } from "@p2/app/v1";
import type { TuiContext } from "@p2/app/v1/tui";
import {
	confirm,
	keyHint,
	lineText,
	type SessionChild,
	type SessionHit,
	type TuiCommand,
	TuiCommands,
	type TuiRuntime,
	TuiScope,
	type TuiSessionPlace,
	TuiSessionPlaces,
	type TuiSessionSource,
	TuiSessionSources,
	TuiSlots,
	type TuiSurface,
} from "@p2/app/v1/tui";
import { MAX_TITLE, type Session, Sessions } from "./contract.ts";
import {
	completeLocation,
	envNames,
	fillInput,
	type Location,
	LocationInput,
	locationLabel,
	ownerEnvs,
	parseLocation,
} from "./tui-location.ts";

type SortMode = "threaded" | "recent" | "relevance";
const SORTS: SortMode[] = ["threaded", "recent", "relevance"];
type Row =
	| { kind: "new" }
	| { kind: "session"; session: Session; prefix: string }
	| { kind: "child"; session: Session; child: SessionChild; prefix: string }
	| { kind: "heading"; text: string }
	| { kind: "message"; hit: SessionHit };

/** pi's `formatSessionDate`. */
function age(timestamp: number): string {
	const minutes = Math.floor((Date.now() - timestamp) / 60000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}
const where = (session: Session): string => `${session.env ? `${session.env}:` : ""}${session.cwd}`;

export class SessionsSurface implements TuiSurface {
	readonly scope: TuiScope;
	readonly runtime: TuiRuntime;
	/** The search box; the cwd and rename prompts reuse `prompt`. */
	readonly search = new Input();
	readonly prompt = new Input();
	focus: Component & Focusable = this.search;
	/** The "+ New session" prompt (directory and environment). */
	private location: LocationInput | undefined;
	private rows: Session[] = [];
	private children: Readonly<Record<string, SessionChild[]>> = {};
	private hits: SessionHit[] = [];
	private sources: TuiSessionSource[] = [];
	private stopSources: (() => void)[] = [];
	private stopRegistry: () => void = () => {};
	private hitsQuery = "";
	private searchTimer: ReturnType<typeof setTimeout> | undefined;
	private owner = false;
	private defaultCwd = "~";
	private defaultEnv: string | null = null;
	private mode: "list" | "create" | "rename" = "list";
	private renaming: Session | undefined;
	private confirming: Session | undefined;
	private status: { text: string; error: boolean } | undefined;
	private scopeAll = false;
	private archived = false;
	private pinnedOnly = false;
	private showIds = false;
	private sort: SortMode = "threaded";
	private selectedIndex = 0;
	private visible: Row[] = [];
	private service: () => Held<typeof Sessions>;

	constructor(runtime: TuiRuntime) {
		this.runtime = runtime;
		this.scope = new TuiScope(runtime);
		this.service = this.scope.watch(Sessions, {}, (ref, follow) => {
			this.owner = ref.variant === "owner";
			const viewer = liveIn(ref, "owner", "guest");
			if (!viewer) return;
			follow(viewer.sessions, (rows) => {
				this.rows = rows;
				this.rebuild();
			});
			if (ref.variant === "owner") {
				follow(ref.defaultCwd, (value) => {
					this.defaultCwd = value ?? "~";
					this.rebuild();
				});
				follow(ref.defaultEnv, (value) => {
					this.defaultEnv = value ?? null;
					this.rebuild();
				});
			}
		});
		// Optional sources (subagents, message search) from the plugins that have them.
		this.stopRegistry = followRegistry(runtime.host, TuiSessionSources, (table) => {
			for (const stop of this.stopSources.splice(0)) stop();
			this.sources = [...table.values()];
			this.children = {};
			for (const source of this.sources)
				if (source.children)
					this.stopSources.push(
						source.children(runtime, (children) => {
							this.children = children;
							this.rebuild();
						}),
					);
			this.rebuild();
		});
		this.prompt.onSubmit = () => this.submitPrompt();
		// "Current folder" follows the viewed session.
		let viewed = runtime.session;
		const changed = (): void => {
			if (runtime.session === viewed) return;
			viewed = runtime.session;
			this.rebuild();
		};
		runtime.listeners.add(changed);
		this.stopListening = () => runtime.listeners.delete(changed);
	}
	private stopListening: () => void;

	private get ctx(): TuiContext {
		return this.runtime.ctx;
	}

	/** The viewed session, which "current folder" means. */
	private get current(): Session | undefined {
		return this.rows.find((row) => row.id === this.runtime.session);
	}

	private inScope(session: Session): boolean {
		if ((session.archivedAt !== null) !== this.archived) return false;
		if (this.pinnedOnly && !session.pinned) return false;
		if (this.scopeAll) return true;
		const current = this.current;
		const env = current ? (current.env ?? null) : this.defaultEnv;
		const cwd = current ? current.cwd : this.defaultCwd;
		return (session.env ?? null) === env && session.cwd === cwd;
	}

	/** Recomputes the rows shown (pi's `filterSessions`). */
	private rebuild(): void {
		const query = this.search.getValue().trim();
		const candidates = this.rows.filter((session) => this.inScope(session));
		const rows: Row[] = this.owner && !this.archived && !query ? [{ kind: "new" }] : [];
		const byRecent = (a: Session, b: Session) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt;
		let sessions: Session[];
		if (query) {
			const matched = fuzzyFilter(
				candidates,
				query,
				(session) => `${session.title} ${where(session)} ${session.id}`,
			);
			sessions = this.sort === "relevance" ? matched : matched.toSorted(byRecent);
		} else sessions = candidates.toSorted(byRecent);
		for (const session of sessions) {
			rows.push({ kind: "session", session, prefix: "" });
			// Threaded: a session's named subagent conversations below it (one-shot agents and archived ones are not listed).
			if (this.sort !== "threaded" || query) continue;
			const kids = this.children[session.id] ?? [];
			for (const [index, child] of kids.entries())
				rows.push({ kind: "child", session, child, prefix: index === kids.length - 1 ? "└─ " : "├─ " });
		}
		if (query && this.hits.length && this.hitsQuery === query) {
			rows.push({ kind: "heading", text: "Messages (literal matches)" });
			for (const hit of this.hits) rows.push({ kind: "message", hit });
		}
		this.visible = rows;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, rows.length - 1));
		if (this.visible[this.selectedIndex]?.kind === "heading") this.selectedIndex++;
		this.runtime.tui.requestRender();
	}

	/** Message hits for the query, debounced (Search is literal and bounded, section 1.17). */
	private queueSearch(): void {
		clearTimeout(this.searchTimer);
		const query = this.search.getValue().trim();
		if (!query) {
			this.hits = [];
			this.hitsQuery = "";
			return;
		}
		const search = this.sources.find((source) => source.search)?.search;
		if (!search || !this.owner) return;
		this.searchTimer = setTimeout(() => {
			void search(this.runtime, query, this.archived)
				.then((hits) => {
					if (this.search.getValue().trim() !== query) return;
					this.hits = hits.slice(0, 40);
					this.hitsQuery = query;
					this.rebuild();
				})
				.catch(() => {});
		}, 200);
	}

	private setStatus(text: string, error = false): void {
		this.status = { text, error };
		this.runtime.tui.requestRender();
	}

	/** Context terms (section 6.3): the selector's own keys apply only while its list has the keys. */
	*contexts(): Iterable<string> {
		if (this.mode === "list" && !this.confirming) yield "selector";
		else yield "creating";
		const input =
			this.mode === "list"
				? this.search
				: this.mode === "create" && this.location
					? this.location.input
					: this.prompt;
		yield "editorFocused";
		if (!input.getValue()) yield "editorEmpty";
	}

	private selected(): Row | undefined {
		return this.visible[this.selectedIndex];
	}

	/** A session of the catalog by ID (the viewed one for `/cd`). */
	session(id: string | undefined): Session | undefined {
		return id === undefined ? undefined : this.rows.find((row) => row.id === id);
	}

	command(name: string): void {
		if (name === "new" && this.owner && statusOf(this.service()) === "live") {
			this.mode = "create";
			const current = this.current;
			this.location = new LocationInput(this.ctx, {
				title: "New session",
				action: "creates",
				env: current ? (current.env ?? null) : this.defaultEnv,
				path: current?.cwd ?? this.defaultCwd,
				onSubmit: (location) => this.create(location),
				onCancel: () => this.closePrompt(),
			});
			this.location.focused = this.runtime.focused;
			this.focus = this.location;
			this.runtime.changed();
		}
	}

	private create(location: Location): void {
		const service = this.service();
		if (statusOf(service) !== "live" || service.variant !== "owner") return;
		this.runtime.perform(
			service.create({ cwd: location.path, env: location.env }, BACKGROUND_CONTEXT).then((session) => {
				if (this.mode === "create") this.closePrompt();
				this.runtime.navigate("chat", session.id);
			}),
		);
	}

	/**
	 * `/new [env:]path`: a session there (no prefix: this device, as the footer writes it; a relative path is below the
	 * home directory), or without an argument in the viewed session's env:cwd; opened at once (pi's `/new`).
	 */
	async createIn(argument: string | undefined): Promise<void> {
		const current = this.current;
		if (!argument) {
			this.create({ env: current ? (current.env ?? null) : this.defaultEnv, path: current?.cwd ?? this.defaultCwd });
			return;
		}
		const location = parseLocation(argument, await envNames(this.ctx), { env: null });
		if ("error" in location) this.runtime.fail(new Error(location.error));
		else this.create(location);
	}

	private submitPrompt(): void {
		const service = this.service();
		if (statusOf(service) !== "live" || service.variant !== "owner") return;
		const value = this.prompt.getValue().trim();
		if (this.mode === "rename" && this.renaming && value) {
			const id = this.renaming.id;
			this.runtime.perform(
				service.rename({ id, title: value.slice(0, MAX_TITLE) }, BACKGROUND_CONTEXT).then(() => {
					this.closePrompt();
					this.setStatus("Session renamed");
				}),
			);
		}
	}

	private closePrompt(): void {
		this.mode = "list";
		this.renaming = undefined;
		this.location = undefined;
		this.focus = this.search;
		this.runtime.changed();
	}

	// ── pi's selector actions (registered as commands below, so the dispatcher routes their keys here) ──

	toggleSort(): void {
		this.sort = SORTS[(SORTS.indexOf(this.sort) + 1) % SORTS.length]!;
		this.rebuild();
	}
	togglePinned(): void {
		this.pinnedOnly = !this.pinnedOnly;
		this.selectedIndex = 0;
		this.rebuild();
	}
	toggleArchived(): void {
		this.archived = !this.archived;
		this.confirming = undefined;
		this.selectedIndex = 0;
		this.queueSearch();
		this.rebuild();
	}
	toggleIds(): void {
		this.showIds = !this.showIds;
		this.runtime.tui.requestRender();
	}
	rename(): void {
		const row = this.selected();
		if (!this.owner || row?.kind !== "session") return;
		this.mode = "rename";
		this.renaming = row.session;
		fillInput(this.prompt, row.session.title);
		this.focus = this.prompt;
		this.runtime.changed();
	}
	pin(): void {
		const row = this.selected();
		const service = this.service();
		if (row?.kind !== "session" || statusOf(service) !== "live" || service.variant !== "owner") return;
		const pinned = !row.session.pinned;
		this.runtime.perform(
			service
				.pin({ id: row.session.id, pinned }, BACKGROUND_CONTEXT)
				.then(() => this.setStatus(pinned ? "Pinned" : "Unpinned")),
		);
	}
	/** Delete = archive (pi asks to confirm); in the archived scope it restores. */
	archive(): void {
		const row = this.selected();
		if (!this.owner || row?.kind !== "session") return;
		if (this.archived) {
			const service = this.service();
			if (statusOf(service) === "live" && service.variant === "owner")
				this.runtime.perform(
					service
						.restore({ id: row.session.id }, BACKGROUND_CONTEXT)
						.then(() => this.setStatus("Session restored")),
				);
			return;
		}
		this.confirming = row.session;
		this.runtime.tui.requestRender();
	}

	private open(row: Row | undefined): void {
		if (!row) return;
		if (row.kind === "new") this.command("new");
		else if (row.kind === "session") this.runtime.navigate("chat", row.session.id, 1);
		else if (row.kind === "child") this.runtime.navigate("chat", row.session.id, row.child.conversationId);
		else if (row.kind === "message") this.runtime.navigate("chat", row.hit.session, row.hit.conversationId);
	}

	private move(delta: number): void {
		if (!this.visible.length) return;
		let index = this.selectedIndex;
		for (let step = 0; step < this.visible.length; step++) {
			index = (index + delta + this.visible.length) % this.visible.length;
			if (this.visible[index]?.kind !== "heading") break;
		}
		this.selectedIndex = index;
	}

	handleInput(data: string): void {
		const keys = this.runtime.keys;
		this.status = undefined;
		if (this.mode === "create" && this.location) {
			this.location.handleInput(data);
			return;
		}
		if (this.mode !== "list") {
			if (keys.matches(data, "tui.select.cancel")) this.closePrompt();
			else this.prompt.handleInput(data);
			return;
		}
		if (this.confirming) {
			const service = this.service();
			if (keys.matches(data, "tui.select.confirm") && statusOf(service) === "live" && service.variant === "owner") {
				const id = this.confirming.id;
				this.runtime.perform(
					service.archive({ id }, BACKGROUND_CONTEXT).then(() => this.setStatus("Session archived")),
				);
			}
			this.confirming = undefined;
			this.runtime.tui.requestRender();
			return;
		}
		if (keys.matches(data, "tui.select.up")) this.move(-1);
		else if (keys.matches(data, "tui.select.down")) this.move(1);
		else if (keys.matches(data, "tui.select.pageUp")) this.move(-10);
		else if (keys.matches(data, "tui.select.pageDown")) this.move(10);
		else if (keys.matches(data, "tui.select.confirm")) this.open(this.selected());
		else if (keys.matches(data, "tui.select.cancel")) {
			if (this.search.getValue()) {
				this.search.setValue("");
				this.selectedIndex = 0;
				this.queueSearch();
				this.rebuild();
			} else if (this.runtime.session) this.runtime.navigate("chat");
		} else if (keys.matches(data, "tui.input.tab")) {
			this.scopeAll = !this.scopeAll;
			this.selectedIndex = 0;
			this.rebuild();
		} else {
			this.search.handleInput(data);
			this.selectedIndex = 0;
			this.queueSearch();
			this.rebuild();
		}
		this.runtime.tui.requestRender();
	}

	private header(width: number): string[] {
		const theme = this.runtime.theme.current;
		const title = this.archived
			? "Archived Sessions"
			: this.scopeAll
				? "Resume Session (All)"
				: "Resume Session (Current Folder)";
		const scope = this.scopeAll
			? `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", "◉ All")}`
			: `${theme.fg("accent", "◉ Current Folder")}${theme.fg("muted", " | ○ All")}`;
		const sortLabel = this.sort === "threaded" ? "Threaded" : this.sort === "recent" ? "Recent" : "Relevance";
		const right = truncateToWidth(
			`${scope}  ${theme.fg("muted", "Pinned: ")}${theme.fg("accent", this.pinnedOnly ? "Only" : "All")}  ${theme.fg("muted", "Sort: ")}${theme.fg("accent", sortLabel)}`,
			width,
			"",
		);
		const left = truncateToWidth(theme.bold(title), Math.max(0, width - visibleWidth(right) - 1), "");
		const line = `${left}${" ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)))}${right}`;
		const sep = theme.fg("muted", " · ");
		const ctx = this.ctx;
		let hints: string[];
		if (this.confirming)
			hints = [
				theme.fg(
					"error",
					`Archive "${lineText(this.confirming.title)}"? ${ctx.keyText("tui.select.confirm")} confirm · ${ctx.keyText("tui.select.cancel")} cancel`,
				),
				"",
			];
		else if (this.status) hints = [theme.fg(this.status.error ? "error" : "accent", this.status.text), ""];
		else {
			const hint = (id: string, label: string) => (ctx.keyText(id) ? keyHint(ctx, id, label) : "");
			hints = [
				[hint("tui.input.tab", "scope"), theme.fg("muted", "literal message search; no regex or phrases")]
					.filter(Boolean)
					.join(sep),
				[
					hint("app.session.toggleSort", "sort"),
					hint("app.session.toggleNamedFilter", "pinned"),
					hint("app.session.toggleArchived", this.archived ? "active" : "archived"),
					...(this.owner
						? [
								hint("app.session.delete", this.archived ? "restore" : "archive"),
								hint("app.session.rename", "rename"),
								hint("p2.session.pin", "pin"),
							]
						: []),
					hint("app.session.togglePath", `ids ${this.showIds ? "(on)" : "(off)"}`),
				]
					.filter(Boolean)
					.join(sep),
			];
		}
		return [line, ...hints.map((text) => truncateToWidth(text, width, "…"))];
	}

	private rowLine(row: Row, selected: boolean, width: number): string {
		const theme = this.runtime.theme.current;
		const cursor = selected ? theme.fg("accent", "› ") : "  ";
		let left: string;
		let right = "";
		if (row.kind === "new") left = theme.fg("accent", "+ New session");
		else if (row.kind === "heading") return theme.fg("muted", `  ${row.text}`);
		else if (row.kind === "message") {
			left = `${lineText(row.hit.title || "Untitled")}${theme.fg("muted", ` — ${lineText(row.hit.text)}`)}`;
			right = row.hit.role;
		} else if (row.kind === "child") {
			left = `${theme.fg("dim", row.prefix)}${theme.fg("accent", lineText(row.child.name))}`;
			right = `${lineText(row.child.model)} conv ${row.child.conversationId}`;
		} else {
			const session = row.session;
			const isCurrent = session.id === this.runtime.session;
			const text = lineText(session.title || "Untitled");
			const color =
				this.confirming?.id === session.id
					? "error"
					: isCurrent
						? "accent"
						: session.pinned
							? "warning"
							: undefined;
			left = color ? theme.fg(color, text) : text;
			right = `${this.scopeAll ? `${lineText(where(session))} ` : ""}${this.showIds ? `${session.id} ` : ""}${age(session.updatedAt)}`;
		}
		const available = Math.max(10, width - 2 - visibleWidth(right) - 2);
		let styled = truncateToWidth(left, available, "…");
		if (selected) styled = theme.bold(styled);
		const leftPart = cursor + styled;
		const line =
			leftPart +
			" ".repeat(Math.max(1, width - visibleWidth(leftPart) - visibleWidth(right))) +
			theme.fg("dim", right);
		return truncateToWidth(selected ? theme.bg("selectedBg", line) : line, width);
	}

	render(width: number): string[] {
		const theme = this.runtime.theme.current;
		if (this.mode === "create" && this.location) return this.location.render(width);
		if (this.mode !== "list") {
			return [
				theme.fg("accent", "Rename session"),
				...this.prompt.render(width),
				theme.fg(
					"dim",
					`${this.ctx.keyText("tui.select.confirm")} saves · ${this.ctx.keyText("tui.select.cancel")} cancels`,
				),
			];
		}
		const lines = [...this.header(width), "", ...this.search.render(width), ""];
		if (this.visible.length === 0) {
			const empty = this.archived
				? "  No archived sessions."
				: this.scopeAll
					? "  No sessions found"
					: "  No sessions in current folder. Press Tab to view all.";
			lines.push(theme.fg("muted", empty));
			return lines;
		}
		const maxVisible = Math.max(3, this.runtime.tui.terminal.rows - 14);
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.visible.length - maxVisible),
		);
		const end = Math.min(start + maxVisible, this.visible.length);
		for (let index = start; index < end; index++)
			lines.push(this.rowLine(this.visible[index]!, index === this.selectedIndex, width));
		if (start > 0 || end < this.visible.length)
			lines.push(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.visible.length})`));
		return lines;
	}

	invalidate(): void {
		this.search.invalidate();
		this.prompt.invalidate();
		this.location?.invalidate();
	}

	dispose(): void {
		this.stopListening();
		clearTimeout(this.searchTimer);
		this.stopRegistry();
		for (const stop of this.stopSources.splice(0)) stop();
		this.scope.dispose();
	}
}

const surfaceOf = (ctx: TuiContext): SessionsSurface | undefined => {
	const surface = ctx.surface("sessions");
	return surface instanceof SessionsSurface ? surface : undefined;
};
const openSessions: TuiCommand["run"] = (ctx) => ctx.navigate("sessions");

/**
 * Moves the viewed session (the web's Relocate, `Sessions.relocate`): the location is resolved and checked as the
 * web's DirectoryPicker does (`Envs.listDirectory`, `~` expanded on the session's environment) and relocated to the
 * listed path; another environment is confirmed first with the web's note. Errors are the server's text, as on the
 * web. Without an argument, a prompt with the environment choice (Tab).
 */
async function relocate(ctx: TuiContext, session: Session, location: Location, confirmed = false): Promise<void> {
	const moving = location.env !== (session.env ?? null);
	// The prompt shows the note above its input, as the web's "Move session to" button: Enter is the confirmation.
	if (
		moving &&
		!confirmed &&
		!(await confirm(ctx, [
			`Move this session to ${locationLabel(location)}?`,
			`Tools will run ${location.env === null ? "on this device" : `on ${lineText(location.env)}`}. The history stays; files are not copied.`,
		]))
	)
		return;
	const envs = await ownerEnvs(ctx);
	if (envs.variant !== "owner") throw new Error("Only the owner changes directories");
	const listing = await envs.listDirectory(
		{ path: location.path, ...(location.env ? { env: location.env } : {}) },
		BACKGROUND_CONTEXT,
	);
	await ctx.host.root(async (root) => {
		const sessions = await root.get(Sessions, {});
		if (sessions.variant !== "owner") throw new Error("Only the owner changes directories");
		await sessions.relocate({ id: session.id, env: location.env, cwd: listing.path }, root);
	}, BACKGROUND_CONTEXT);
	ctx.notify(`Working directory: ${lineText(locationLabel({ env: location.env, path: listing.path }))}`);
}

/**
 * `/envs`, Enter on an environment: the viewed session moves there. The directory prompt opens on that environment,
 * prefilled with the session's directory when it exists there, else that machine's home; its note confirms the move
 * (as in `/cd`), then `Sessions.relocate`.
 */
async function moveTo(ctx: TuiContext, env: string | null): Promise<void> {
	const session = surfaceOf(ctx)?.session(ctx.identity.session);
	if (!session) {
		ctx.notify("Open a session to move it", "warning");
		return;
	}
	const envs = await ownerEnvs(ctx);
	if (envs.variant !== "owner") return;
	const list = (path: string) => envs.listDirectory({ path, ...(env ? { env } : {}) }, BACKGROUND_CONTEXT);
	let path = "~";
	let error: string | undefined;
	try {
		path = (await list(session.cwd)).path;
	} catch {
		try {
			path = (await list("~")).path;
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}
	}
	const overlay = ctx.overlay(
		"cd",
		new LocationInput(ctx, {
			title: "Working directory",
			action: "moves the session",
			env,
			path,
			moving: true,
			movingFrom: session.env ?? null,
			...(error ? { error } : {}),
			onSubmit: (location) => {
				overlay.close();
				void relocate(ctx, session, location, true).catch((caught: unknown) =>
					ctx.notify(caught instanceof Error ? caught.message : String(caught), "error"),
				);
			},
			onCancel: () => overlay.close(),
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
}

const PLACE: TuiSessionPlace = {
	where: (ctx) => {
		const session = surfaceOf(ctx)?.session(ctx.identity.session);
		return session ? { env: session.env ?? null, cwd: session.cwd } : undefined;
	},
	moveTo,
};

async function changeDirectory(ctx: TuiContext, argument: string): Promise<void> {
	const session = surfaceOf(ctx)?.session(ctx.identity.session);
	if (!session) return;
	const fallback = { env: session.env ?? null, cwd: session.cwd };
	if (argument) {
		const location = parseLocation(argument, await envNames(ctx), fallback);
		if ("error" in location) ctx.notify(location.error, "error");
		else await relocate(ctx, session, location);
		return;
	}
	const overlay = ctx.overlay(
		"cd",
		new LocationInput(ctx, {
			title: "Working directory",
			action: "moves the session",
			env: fallback.env,
			path: session.cwd,
			moving: true,
			onSubmit: (location) => {
				overlay.close();
				void relocate(ctx, session, location, true).catch((error: unknown) =>
					ctx.notify(error instanceof Error ? error.message : String(error), "error"),
				);
			},
			onCancel: () => overlay.close(),
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
}
/** The selector's own keys: more specific than app.exit/app.clear so Ctrl+D archives here, as pi's Ctrl+D deletes. */
const SELECTOR = "sessions && selector && !overlay && !creating";
const selectorCommand = (title: string, run: (surface: SessionsSurface) => void, keys?: string): TuiCommand => ({
	title,
	category: "Sessions",
	when: SELECTOR,
	palette: false,
	...(keys ? { keys: keys as TuiCommand["keys"] } : {}),
	run: (ctx) => {
		const surface = surfaceOf(ctx);
		if (surface) run(surface);
	},
});

const SESSION_COMMANDS: Record<string, TuiCommand> = {
	// pi's app.session.* are unbound by default; p2.sessions keeps Ctrl+R in the chat context (section 1.11).
	"p2.sessions": {
		title: "Sessions",
		category: "Session",
		keys: "ctrl+r",
		when: "chat",
		slash: { name: "sessions" },
		run: openSessions,
	},
	"app.session.resume": {
		title: "Resume a session",
		category: "Session",
		when: "!overlay",
		slash: { name: "resume" },
		run: openSessions,
	},
	"app.session.new": {
		title: "New session",
		category: "Session",
		when: "owner && !overlay",
		slash: {
			name: "new",
			argumentHint: "[[env:]path]",
			complete: (prefix, ctx) => completeLocation(ctx, prefix, { env: null }),
			tabOnly: true,
		},
		run: async (ctx, args) => {
			ctx.navigate("sessions");
			const surface = surfaceOf(ctx);
			if (!surface) return;
			// pi's `/new` starts over in the same directory; without a session to follow, ask for one.
			if (args?.trim() || ctx.identity.session) await surface.createIn(args?.trim());
			else surface.command("new");
		},
	},
	"p2.session.cd": {
		title: "Change the working directory",
		category: "Session",
		when: "chat && owner && !overlay",
		slash: {
			name: "cd",
			argumentHint: "[[env:]path]",
			complete: (prefix, ctx) => {
				const session = surfaceOf(ctx)?.session(ctx.identity.session);
				return session ? completeLocation(ctx, prefix, { env: session.env ?? null, cwd: session.cwd }) : null;
			},
			tabOnly: true,
		},
		run: (ctx, args) => changeDirectory(ctx, args?.trim() ?? ""),
	},
	"p2.session.name": {
		title: "Name the session",
		category: "Session",
		when: "chat && owner && !overlay",
		slash: { name: "name", argumentHint: "<title>" },
		run: async (ctx, args) => {
			const session = ctx.identity.session;
			const title = args?.trim().slice(0, MAX_TITLE);
			if (!session) return;
			if (!title) {
				ctx.notify("Usage: /name <title>");
				return;
			}
			await ctx.host.root(async (root) => {
				const sessions = await root.get(Sessions, {});
				if (sessions.variant !== "owner") throw new Error("Only the owner renames sessions");
				await sessions.rename({ id: session, title }, root);
			}, BACKGROUND_CONTEXT);
			ctx.notify(`Session name: ${title}`);
		},
	},
	"app.session.toggleSort": selectorCommand("Toggle session sort", (surface) => surface.toggleSort()),
	"app.session.toggleNamedFilter": selectorCommand("Toggle pinned filter", (surface) => surface.togglePinned()),
	"app.session.toggleArchived": selectorCommand(
		"Toggle archived sessions",
		(surface) => surface.toggleArchived(),
		"ctrl+a",
	),
	"app.session.togglePath": selectorCommand("Toggle session IDs", (surface) => surface.toggleIds()),
	"app.session.delete": selectorCommand("Archive or restore session", (surface) => surface.archive()),
	"app.session.rename": selectorCommand("Rename session", (surface) => surface.rename()),
	"p2.session.pin": selectorCommand("Pin or unpin session", (surface) => surface.pin(), "alt+p"),
};

export default defineFacet((host) =>
	contribute(host, "p2.tui-sessions", (self) => {
		self.contribute(TuiSlots, { sessions: (runtime: TuiRuntime): TuiSurface => new SessionsSurface(runtime) });
		self.contribute(TuiCommands, SESSION_COMMANDS);
		self.contribute(TuiSessionPlaces, { sessions: PLACE });
	}),
);
