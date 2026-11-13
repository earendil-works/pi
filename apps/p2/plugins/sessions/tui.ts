// The sessions screen: pi's `/resume` session selector (coding-agent interactive/components/session-selector.ts) on
// p2's data, with the adaptations of p2-tui-port.md section 1.17:
// - one line per session (activity marker, title, env:cwd in the "all" scope, age); Tab switches the current env:cwd /
//   all sessions; the marker is the web drawer's dot: working, a failed worker, else an unread answer (owner); the
//   chat showing a session's main conversation reads it through its latest answer, as the web does;
// - local fuzzy filtering over title, env:cwd and ID; message hits come from `Search` (owner), in a separate
//   "Messages" group of literal matches; pi's phrases and `re:` are unsupported (the hint says so);
// - sorts: threaded (sessions with their subagent conversations nested, `Subagents`), recent, relevance;
// - pi's named filter is a pinned filter; delete means archive (confirmed), restored from the archived scope (Ctrl+A);
// - rename and pin (owner). Selecting a subagent opens its conversation: the (session, conversation) identity.
// `+ New session` asks for a working directory, Tab choosing the environment; `/new [env:]path` creates one directly;
// `/cd [env:]path` relocates the viewed session (the web's Relocate); `/name`, `/session` live here and in the status
// plugin. With projects (`projects.json`, owner) and an empty search, the list is grouped: each project's row (its
// places probed in the background; Enter creates a session in the project at the first reachable place, or the one
// picked with left/right) with its sessions below it, then "Other" ("+ New session" and the sessions of no project).
// The grouped list shows every session; Tab's scope (current folder / all) applies to the flat lists. `/move` moves the
// viewed session within its project (tui-move.ts).

import {
	type Component,
	type Focusable,
	fuzzyFilter,
	Input,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Held, HeldIn } from "@p2/app/v1";
import { BACKGROUND_CONTEXT, contribute, defineFacet, followRegistry, liveIn } from "@p2/app/v1";
import type { TuiContext } from "@p2/app/v1/tui";
import {
	confirm,
	keyHint,
	lineText,
	type OptimisticAdd,
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
import { type Project, type ProjectPlace, Projects, placeLabel } from "../projects/contract.ts";
import { SessionReads } from "../search/contract.ts";
import { SessionStatus, type Status } from "../status/contract.ts";
import { MAX_TITLE, type Operation, type Session, Sessions } from "./contract.ts";
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
import { completeMove, runMove } from "./tui-move.ts";
import { PLACE_MARK, PlaceProbes, placeProblem } from "./tui-projects.ts";

type SortMode = "threaded" | "recent" | "relevance";
const SORTS: SortMode[] = ["threaded", "recent", "relevance"];
type Row =
	| { kind: "project"; project: Project }
	| { kind: "new"; prefix: string }
	| { kind: "session"; session: Session; prefix: string }
	| { kind: "child"; session: Session; child: SessionChild; prefix: string; indent: string }
	| { kind: "heading"; text: string; error?: boolean }
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

/** How operations read in the selector and on status lines, by kind. */
const OPERATION_TEXT: Record<Operation["kind"], { running: string; failed: string; done: string }> = {
	relocate: { running: "moving…", failed: "Move failed", done: "Session moved" },
	clone: { running: "cloning…", failed: "Clone failed", done: "Clone ready" },
	fork: { running: "forking…", failed: "Fork failed", done: "Fork ready" },
	archive: { running: "archiving…", failed: "Archive failed", done: "Session archived" },
};

/** A change to one session's row while its call is in flight (a rename, a pin, an archive or restore, a move). */
type RowGuess = {
	readonly id: string;
	readonly change: Partial<Pick<Session, "title" | "pinned" | "archivedAt" | "env" | "cwd">>;
};
const applyRow = (rows: Session[], { id, change }: RowGuess): Session[] =>
	rows.map((row) => (row.id === id ? { ...row, ...change } : row));

export class SessionsSurface implements TuiSurface {
	readonly scope: TuiScope;
	readonly runtime: TuiRuntime;
	/** The search box; the cwd and rename prompts reuse `prompt`. */
	readonly search = new Input();
	readonly prompt = new Input();
	focus: Component & Focusable = this.search;
	/** The "+ New session" prompt (directory and environment). */
	private location: LocationInput | undefined;
	private received: Session[] = [];
	/** The catalog's lifecycle operations (owner): running ones mark their rows, failed ones are announced. */
	private operations: Operation[] = [];
	/** Row changes whose calls are in flight: the list shows them at once and rolls back a refused one. */
	private shownRows: () => Session[];
	private editing: OptimisticAdd<RowGuess>;
	private children: Readonly<Record<string, SessionChild[]>> = {};
	/** Each session's worker status (`SessionStatus`): its busy conversations and a failure. */
	private statuses: Readonly<Record<string, Status>> = {};
	/** Each session's latest root answer and how far the owner read it (`SessionReads`, owner only). */
	private answers: Readonly<Record<string, number>> = {};
	private reads: Readonly<Record<string, number>> = {};
	private marks: Held<typeof SessionReads> | undefined;
	/** The last `markRead` sent (`session:through`): runtime changes come often, the call goes once per answer. */
	private marked = "";
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
	private service: Held<typeof Sessions>;
	/** The owner's projects (`projects.json`), why its last read failed, and this device's name in their rows. */
	private projectList: readonly Project[] = [];
	private label = "this device";
	private projectsFailure: string | null = null;
	/** The sessions' projects by session ID (`Projects.sessions`): a name may outlive its project in projects.json. */
	private memberships: Readonly<Record<string, string>> = {};
	private projectsRef: Held<typeof Projects> | undefined;
	private readonly probes: PlaceProbes;
	/**
	 * The place picked with left/right per project name until the selector is shown again; without one, Enter takes the
	 * first reachable place.
	 */
	private readonly picked = new Map<string, number>();
	/** Counts Enters on project rows: only the latest one, still on the selector, creates a session. */
	private openAttempt = 0;
	/** Whether the selector was shown at the last change: showing it probes every place again. */
	private shown = false;

	constructor(runtime: TuiRuntime) {
		this.runtime = runtime;
		this.scope = new TuiScope(runtime);
		this.probes = new PlaceProbes(runtime.ctx, () => this.rebuild());
		[this.shownRows, this.editing] = this.scope.optimistic(() => this.received, applyRow);
		this.service = this.scope.watch(Sessions, {}, (ref, follow) => {
			this.owner = ref.variant === "owner";
			const viewer = liveIn(ref, "owner", "guest");
			if (!viewer) return;
			follow(viewer.sessions, (rows) => {
				this.received = rows;
				this.followMains(rows);
				this.rebuild();
			});
			if (ref.variant === "owner") {
				// Unread answers are the owner's (any device); guests see none.
				this.marks = this.scope.watch(SessionReads, {}, (reads, followReads) => {
					followReads(reads.answers, (answers) => {
						this.answers = answers;
						this.markShownRead();
					});
					followReads(reads.reads, (value) => {
						this.reads = value;
						this.markShownRead();
					});
				});
				this.followProjects();
				follow(ref.operations, (operations) => this.followOperations(operations));
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
		// Owners and guests are readers (a guest's view holds its granted sessions, without error texts).
		this.scope.watch(SessionStatus, {}, (ref, follow) => {
			if (ref.variant === "reader")
				follow(ref.statuses, (statuses) => {
					this.statuses = statuses;
				});
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
		// "Current folder" follows the viewed session; showing the selector probes the projects' places again.
		let viewed = runtime.session;
		const changed = (): void => {
			this.markShownRead();
			const shown = runtime.screen === "sessions";
			if (shown && !this.shown) {
				this.picked.clear();
				this.probes.restart(this.projects.flatMap((project) => project.places));
			}
			this.shown = shown;
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

	/** The chat showing a session's main conversation reads it through its latest answer (the web's rule, owner). */
	private markShownRead(): void {
		const { screen, session, conversation } = this.runtime;
		const marks = liveIn(this.marks, "owner");
		if (!marks || screen !== "chat" || !session || conversation !== this.runtime.mainOf(session)) return;
		const latest = this.answers[session] ?? 0;
		const key = `${session}:${latest}`;
		if (latest <= (this.reads[session] ?? 0) || key === this.marked) return;
		this.marked = key;
		void marks.markRead({ session, through: latest }, BACKGROUND_CONTEXT).catch(() => {});
	}

	/** Follows the owner's projects (once): new places are probed at once while the selector is shown. */
	private followProjects(): void {
		if (this.projectsRef) return;
		this.projectsRef = this.scope.watch(Projects, {}, (ref, follow) => {
			if (ref.variant !== "owner") return;
			follow(ref.projects, (projects) => {
				this.projectList = projects;
				if (this.shown) this.probes.probe(projects.flatMap((project) => project.places));
				this.rebuild();
			});
			follow(ref.failure, (failure) => {
				this.projectsFailure = failure;
				this.rebuild();
			});
			follow(ref.local, (label) => {
				this.label = label;
				this.rebuild();
			});
			follow(ref.sessions, (sessions) => {
				this.memberships = sessions;
				this.rebuild();
			});
		});
	}

	/** The owner's projects, in projects.json's order (`/move` reads them too). */
	get projects(): readonly Project[] {
		return this.projectList;
	}

	/** This device's name in place labels: the server's hostname. */
	get localLabel(): string {
		return this.label;
	}

	/** The project session `id` belongs to, by name (perhaps no longer in projects.json). */
	projectOf(id: string): string | undefined {
		return this.memberships[id];
	}

	/**
	 * Announces what changed in the lifecycle operations: a failure (as an error line until `/dismiss-failed`), and a
	 * running operation that ended without one (a move done, a copy ready).
	 */
	private followOperations(operations: Operation[]): void {
		const before = new Map(this.operations.map((operation) => [operation.id, operation]));
		this.operations = operations;
		for (const operation of operations)
			if (operation.phase === "failed" && before.get(operation.id)?.phase !== "failed")
				this.runtime.notify(
					`${OPERATION_TEXT[operation.kind].failed}: ${lineText(operation.error)} · /dismiss-failed`,
					"error",
				);
		for (const [id, operation] of before)
			if (operation.phase === "running" && !operations.some((each) => each.id === id))
				this.runtime.notify(OPERATION_TEXT[operation.kind].done);
		this.rebuild();
	}

	/** What a row says about an operation on it: failed, running, or a copy into it whose files are copied. */
	private operationText(session: string): string {
		const operation =
			this.operations.find((each) => each.phase === "failed" && each.session === session) ??
			this.operations.find((each) => each.session === session) ??
			this.operations.find((each) => each.phase === "running" && each.target === session && each.copying);
		if (!operation) return "";
		if (operation.phase === "failed") return `${OPERATION_TEXT[operation.kind].failed} `;
		return operation.session === session ? `${OPERATION_TEXT[operation.kind].running} ` : "copying files… ";
	}

	/** `/dismiss-failed`: forgets every failed operation (their lines go from every client's list). */
	dismissFailed(): void {
		const catalog = this.catalog;
		const failed = this.operations.filter((operation) => operation.phase === "failed");
		if (!catalog || !failed.length) {
			this.runtime.notify("No failed operations");
			return;
		}
		for (const operation of failed)
			this.runtime.perform(catalog.dismissOperation({ operation: operation.id }, BACKGROUND_CONTEXT));
	}

	/** The catalog as shown: the server's rows with the changes in flight. */
	private get rows(): Session[] {
		return this.shownRows();
	}

	/** The owner's live catalog, which every change goes through. */
	get catalog(): HeldIn<typeof Sessions, "owner"> | undefined {
		return liveIn(this.service, "owner");
	}

	/**
	 * Changes a row: shown at once, `done` once the server took it (the selector's status, else a status line); a
	 * refused change rolls back and its error shows as a status line.
	 */
	edit(guess: RowGuess, call: (catalog: HeldIn<typeof Sessions, "owner">) => Promise<unknown>, done: string): void {
		const catalog = this.catalog;
		if (!catalog) return;
		const settled = this.editing(guess, call(catalog)).then(() => {
			if (this.runtime.screen === "sessions") this.setStatus(done);
			else this.runtime.notify(done);
		});
		this.rebuild();
		this.runtime.perform(settled.finally(() => this.rebuild()));
	}

	/** The viewed session, which "current folder" means. */
	private get current(): Session | undefined {
		return this.rows.find((row) => row.id === this.runtime.session);
	}

	private inScope(session: Session): boolean {
		if ((session.archivedAt !== null) !== this.archived) return false;
		if (this.pinnedOnly && !session.pinned) return false;
		if (this.scopeAll || this.grouped) return true;
		const current = this.current;
		const env = current ? (current.env ?? null) : this.defaultEnv;
		const cwd = current ? current.cwd : this.defaultCwd;
		return (session.env ?? null) === env && session.cwd === cwd;
	}

	/**
	 * Whether the list is grouped by project: the owner's active sessions without a search, with projects. It shows every
	 * session, so Tab's scope does not apply.
	 */
	private get grouped(): boolean {
		return this.owner && !this.archived && this.projects.length > 0 && !this.search.getValue().trim();
	}

	/** Recomputes the rows shown (pi's `filterSessions`). */
	private rebuild(): void {
		const query = this.search.getValue().trim();
		const candidates = this.rows.filter((session) => this.inScope(session));
		const rows: Row[] = [];
		const byRecent = (a: Session, b: Session) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt;
		const creating = this.owner && !this.archived && !query;
		if (creating && this.projectsFailure) rows.push({ kind: "heading", text: this.projectsFailure, error: true });
		if (this.grouped) this.groupRows(rows, candidates.toSorted(byRecent));
		else if (creating) {
			rows.push({ kind: "new", prefix: "" });
			this.sessionRows(rows, candidates.toSorted(byRecent), "");
		} else {
			const matched = query
				? fuzzyFilter(candidates, query, (session) => `${session.title} ${where(session)} ${session.id}`)
				: candidates;
			this.sessionRows(rows, query && this.sort === "relevance" ? matched : matched.toSorted(byRecent), "");
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

	/**
	 * The grouped list (empty search, owner): each project's row with its sessions below it, in projects.json's order,
	 * then "Other": "+ New session" and the sessions of no project, or of one projects.json no longer has.
	 */
	private groupRows(rows: Row[], sessions: readonly Session[]): void {
		for (const project of this.projects) {
			rows.push({ kind: "project", project });
			this.sessionRows(
				rows,
				sessions.filter((session) => this.projectOf(session.id) === project.name),
				"  ",
			);
		}
		rows.push({ kind: "heading", text: "Other" });
		rows.push({ kind: "new", prefix: "  " });
		const grouped = new Set(this.projects.map((project) => project.name));
		this.sessionRows(
			rows,
			sessions.filter((session) => !grouped.has(this.projectOf(session.id) ?? "")),
			"  ",
		);
	}

	/**
	 * Session rows indented by `indent`; in the threaded sort without a search, each with its named subagent
	 * conversations below it (one-shot agents and archived ones are not listed).
	 */
	private sessionRows(rows: Row[], sessions: readonly Session[], indent: string): void {
		const threaded = this.sort === "threaded" && !this.search.getValue().trim();
		for (const session of sessions) {
			rows.push({ kind: "session", session, prefix: indent });
			const kids = threaded ? (this.children[session.id] ?? []) : [];
			for (const [index, child] of kids.entries())
				rows.push({ kind: "child", session, child, prefix: index === kids.length - 1 ? "└─ " : "├─ ", indent });
		}
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
		if (name === "new" && this.catalog) {
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

	/**
	 * Keeps the runtime's main conversations; a `/tree` switch (here or on another device) moves a TUI viewing the
	 * previous main conversation to the new one.
	 */
	private followMains(rows: readonly Session[]): void {
		const runtime = this.runtime;
		for (const row of rows) {
			const before = runtime.mains.get(row.id);
			runtime.mains.set(row.id, row.main);
			if (
				before !== undefined &&
				before !== row.main &&
				runtime.session === row.id &&
				runtime.conversation === before
			)
				runtime.navigate(runtime.screen, row.id, row.main);
		}
	}

	/**
	 * Creates a session and opens it at once: this TUI chooses its ID, and the conversation shows loading until the
	 * session's worker runs. From a project row it belongs to `project`, recorded first (`Projects.assign`) so its row
	 * never shows under "Other". A refused creation comes back to the selector with the error.
	 */
	private create(location: Location, project?: string): void {
		const catalog = this.catalog;
		if (!catalog) return;
		const projects = this.projectsRef && liveIn(this.projectsRef, "owner");
		const id = crypto.randomUUID();
		if (this.mode === "create") this.closePrompt();
		this.runtime.navigate("chat", id);
		const assigned =
			project && projects ? projects.assign({ session: id, project }, BACKGROUND_CONTEXT) : Promise.resolve(null);
		void assigned
			.then(() => catalog.create({ id, cwd: location.path, env: location.env }, BACKGROUND_CONTEXT))
			.catch((error: unknown) => {
				if (this.runtime.session === id) this.runtime.navigate("sessions", undefined);
				this.runtime.fail(error);
			});
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
		const value = this.prompt.getValue().trim();
		if (this.mode !== "rename" || !this.renaming || !value) return;
		this.renameSession(this.renaming.id, value);
		this.closePrompt();
	}

	/** Renames session `id` (the selector's prompt, `/name`): the new title shows at once. */
	renameSession(id: string, value: string): void {
		const title = value.slice(0, MAX_TITLE);
		this.edit(
			{ id, change: { title } },
			(catalog) => catalog.rename({ id, title }, BACKGROUND_CONTEXT),
			`Session name: ${lineText(title)}`,
		);
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
		if (row?.kind !== "session") return;
		const { id } = row.session;
		const pinned = !row.session.pinned;
		this.edit(
			{ id, change: { pinned } },
			(catalog) => catalog.pin({ id, pinned }, BACKGROUND_CONTEXT),
			pinned ? "Pinned" : "Unpinned",
		);
	}
	/** Delete = archive (pi asks to confirm); in the archived scope it restores. */
	archive(): void {
		const row = this.selected();
		if (!this.owner || row?.kind !== "session") return;
		if (this.archived) {
			const { id } = row.session;
			this.edit(
				{ id, change: { archivedAt: null } },
				(catalog) => catalog.restore({ id }, BACKGROUND_CONTEXT),
				"Session restored",
			);
			return;
		}
		this.confirming = row.session;
		this.runtime.tui.requestRender();
	}

	/** The place Enter on `project`'s row uses: the one picked with left/right, else the first reachable one. */
	private target(project: Project): ProjectPlace | undefined {
		const picked = this.picked.get(project.name);
		const place = picked === undefined ? undefined : project.places[picked];
		return place ?? project.places.find((each) => this.probes.state(each).kind === "reachable");
	}

	/** Left/right on a project row: the previous or next place becomes Enter's. */
	private pickPlace(project: Project, delta: number): void {
		const target = this.target(project);
		const index = target ? project.places.indexOf(target) : delta > 0 ? -1 : 0;
		const count = project.places.length;
		this.picked.set(project.name, (index + delta + count) % count);
	}

	/**
	 * Enter on a project row: a session at the picked place, else at the first reachable place in preference order,
	 * waiting for the probes still running; the reasons when none is reachable. A later Enter, or leaving the selector,
	 * abandons the wait.
	 */
	private async openProject(project: Project): Promise<void> {
		const attempt = ++this.openAttempt;
		const picked = this.picked.get(project.name);
		const chosen = picked === undefined ? undefined : project.places[picked];
		const failures: string[] = [];
		this.setStatus(`Checking ${lineText(project.name)}'s places…`);
		for (const place of chosen ? [chosen] : project.places) {
			const state = await this.probes.result(place);
			if (attempt !== this.openAttempt || this.runtime.screen !== "sessions") return;
			if (state.kind === "reachable") {
				this.status = undefined;
				this.create({ env: place.env, path: state.path }, project.name);
				return;
			}
			const problem = placeProblem(placeLabel(place, this.localLabel), state);
			if (problem) failures.push(problem);
		}
		this.setStatus(`No reachable place: ${lineText(failures.join(" · "))}`, true);
	}

	private open(row: Row | undefined): void {
		if (!row) return;
		if (row.kind === "project")
			void this.openProject(row.project).catch((error: unknown) => this.runtime.fail(error));
		else if (row.kind === "new") this.command("new");
		else if (row.kind === "session") this.runtime.navigate("chat", row.session.id, row.session.main);
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
			if (keys.matches(data, "tui.select.confirm")) {
				const { id } = this.confirming;
				this.edit(
					{ id, change: { archivedAt: Date.now() } },
					(catalog) => catalog.archive({ id }, BACKGROUND_CONTEXT),
					"Session archived",
				);
			}
			this.confirming = undefined;
			this.runtime.tui.requestRender();
			return;
		}
		// Left/right pick a project row's place: those rows show only while the search is empty, whose cursor stays put.
		const row = this.selected();
		const pick = keys.matches(data, "tui.editor.cursorLeft")
			? -1
			: keys.matches(data, "tui.editor.cursorRight")
				? 1
				: 0;
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
		} else if (row?.kind === "project" && pick) this.pickPlace(row.project, pick);
		else if (keys.matches(data, "tui.input.tab")) {
			if (this.grouped) return;
			this.scopeAll = !this.scopeAll;
			this.selectedIndex = 0;
			this.rebuild();
		} else {
			const grouped = this.grouped;
			this.search.handleInput(data);
			// A search typed in the grouped list (which shows every session) searches every session; Tab narrows it.
			if (grouped && !this.grouped) this.scopeAll = true;
			this.selectedIndex = 0;
			this.queueSearch();
			this.rebuild();
		}
		this.runtime.tui.requestRender();
	}

	private header(width: number): string[] {
		const theme = this.runtime.theme.current;
		// The grouped list has no scope: every session shows.
		const grouped = this.grouped;
		const title = this.archived
			? "Archived Sessions"
			: grouped
				? "Resume Session"
				: this.scopeAll
					? "Resume Session (All)"
					: "Resume Session (Current Folder)";
		const scope = grouped
			? ""
			: this.scopeAll
				? `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", "◉ All")}  `
				: `${theme.fg("accent", "◉ Current Folder")}${theme.fg("muted", " | ○ All")}  `;
		const sortLabel = this.sort === "threaded" ? "Threaded" : this.sort === "recent" ? "Recent" : "Relevance";
		const right = truncateToWidth(
			`${scope}${theme.fg("muted", "Pinned: ")}${theme.fg("accent", this.pinnedOnly ? "Only" : "All")}  ${theme.fg("muted", "Sort: ")}${theme.fg("accent", sortLabel)}`,
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
			const place =
				this.selected()?.kind === "project" && ctx.keyText("tui.editor.cursorLeft")
					? theme.fg("dim", `${ctx.keyText("tui.editor.cursorLeft")}/${ctx.keyText("tui.editor.cursorRight")}`) +
						theme.fg("muted", " place")
					: "";
			hints = [
				[
					grouped ? "" : hint("tui.input.tab", "scope"),
					place,
					theme.fg("muted", "literal message search; no regex or phrases"),
				]
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

	/**
	 * A row's activity marker, two columns wide on every row so titles do not shift: working (accent dot), a failed
	 * worker (error), an unread answer (muted ring), else blank. A subagent row is working when its conversation is.
	 */
	private marker(row: Row): string {
		const theme = this.runtime.theme.current;
		if (row.kind !== "session" && row.kind !== "child") return "  ";
		const id = row.session.id;
		const status = this.statuses[id];
		const busy = status?.busy ?? [];
		if (row.kind === "child") return busy.includes(row.child.conversationId) ? theme.fg("accent", "● ") : "  ";
		if (busy.length) return theme.fg("accent", "● ");
		if (status?.error) return theme.fg("error", "! ");
		if ((this.answers[id] ?? 0) > (this.reads[id] ?? 0)) return theme.fg("muted", "◦ ");
		return "  ";
	}

	private rowLine(row: Row, selected: boolean, width: number): string {
		const theme = this.runtime.theme.current;
		const cursor = selected ? theme.fg("accent", "› ") : "  ";
		let left: string;
		let right = "";
		if (row.kind === "new") left = theme.fg("accent", "+ New session");
		else if (row.kind === "heading")
			return truncateToWidth(theme.fg(row.error ? "error" : "muted", `  ${lineText(row.text)}`), width);
		else if (row.kind === "project") {
			const target = this.target(row.project);
			const places = row.project.places.map((place) => {
				const label = lineText(placeLabel(place, this.localLabel));
				const mark = PLACE_MARK[this.probes.state(place).kind];
				return `${place === target ? theme.fg("accent", label) : label} ${theme.fg(mark.color, mark.text)}`;
			});
			left = `${lineText(row.project.name)}   ${places.join("   ")}`;
		} else if (row.kind === "message") {
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
			// A project projects.json no longer has: the session waits under "Other", dimmed, with the old name.
			const project = this.projectOf(session.id);
			const gone = project !== undefined && !this.projects.some((each) => each.name === project);
			const shown = gone ? theme.fg("dim", `${text} (${lineText(project)})`) : color ? theme.fg(color, text) : text;
			left = shown;
			right = `${this.operationText(session.id)}${this.scopeAll || this.grouped ? `${lineText(where(session))} ` : ""}${this.showIds ? `${session.id} ` : ""}${age(session.updatedAt)}`;
		}
		// A group's rows are indented before their activity marker; a project row is its group's heading, without one.
		const indent = row.kind === "session" || row.kind === "new" ? row.prefix : row.kind === "child" ? row.indent : "";
		const lead = cursor + indent + (row.kind === "project" ? "" : this.marker(row));
		const available = Math.max(10, width - visibleWidth(lead) - visibleWidth(right) - 2);
		let styled = truncateToWidth(left, available, "…");
		if (selected) styled = theme.bold(styled);
		const leftPart = lead + styled;
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
		for (let index = start; index < end; index++) {
			const row = this.visible[index]!;
			lines.push(this.rowLine(row, index === this.selectedIndex, width));
			if (index === this.selectedIndex && row.kind === "project") {
				// The selected project's unusable places, with why: a mark alone does not say.
				const problems = row.project.places.flatMap(
					(place) => placeProblem(placeLabel(place, this.localLabel), this.probes.state(place)) ?? [],
				);
				if (problems.length)
					lines.push(truncateToWidth(theme.fg("muted", `    ${lineText(problems.join(" · "))}`), width, "…"));
			}
		}
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
 * web's DirectoryPicker does (`Envs.listDirectory`, `~` expanded on the session's environment), then the session row
 * shows the listed path at once while the move runs; a refused move (a busy session) rolls back with the server's
 * text. Another environment is confirmed first with the web's note.
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
	const { path } = await envs.listDirectory(
		{ path: location.path, ...(location.env ? { env: location.env } : {}) },
		BACKGROUND_CONTEXT,
	);
	// A move is long work (a job): the row says "moving…" until it is done ("Session moved"), or failed.
	const catalog = surfaceOf(ctx)?.catalog;
	if (!catalog) return;
	ctx.notify(`Moving to ${lineText(locationLabel({ env: location.env, path }))}…`);
	await catalog.relocate({ id: session.id, env: location.env, cwd: path }, BACKGROUND_CONTEXT);
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
				void relocate(ctx, session, location, true).catch((caught: unknown) => ctx.fail(caught));
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
				void relocate(ctx, session, location, true).catch((error: unknown) => ctx.fail(error));
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
	"p2.session.move": {
		title: "Move the session to its project on another machine",
		category: "Session",
		when: "chat && owner && !overlay",
		slash: {
			name: "move",
			argumentHint: "[env]",
			complete: (prefix, ctx) => {
				const surface = surfaceOf(ctx);
				return surface ? completeMove(ctx, surface, prefix) : null;
			},
			tabOnly: true,
		},
		run: async (ctx, args) => {
			const surface = surfaceOf(ctx);
			if (surface)
				await runMove(ctx, surface, args?.trim() ?? "", (session, location) => relocate(ctx, session, location));
		},
	},
	"p2.session.name": {
		title: "Name the session",
		category: "Session",
		when: "chat && owner && !overlay",
		slash: { name: "name", argumentHint: "<title>" },
		run: (ctx, args) => {
			const session = ctx.identity.session;
			const title = args?.trim();
			if (!session) return;
			if (title) surfaceOf(ctx)?.renameSession(session, title);
			else ctx.notify("Usage: /name <title>");
		},
	},
	"p2.session.dismissFailed": {
		title: "Dismiss failed session operations",
		category: "Session",
		when: "owner && !overlay",
		slash: { name: "dismiss-failed" },
		run: (ctx) => surfaceOf(ctx)?.dismissFailed(),
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
