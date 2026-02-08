import { Container, Editor, Input, Spacer, Text } from "@kennyfrc/mu-tui";
import { copyToClipboard } from "../clipboard.js";
import { getEditorTheme, theme } from "../theme/theme.js";
import { formatTodoMarkdown } from "../todos/todo-file.js";
import type { TodoRecord, TodoStore, WhoAmI } from "../todos/todo-store.js";
import { DynamicBorder } from "./dynamic-border.js";

type OverlayMode = "list" | "actions" | "view" | "append";

interface TodoDisplayRowHeader {
	kind: "header";
	label: string;
}

interface TodoDisplayRowTodo {
	kind: "todo";
	todo: TodoRecord;
}

type TodoDisplayRow = TodoDisplayRowHeader | TodoDisplayRowTodo;

type TodoAction =
	| "view"
	| "claim"
	| "release"
	| "mark_in_progress"
	| "mark_done"
	| "mark_cancelled"
	| "append_note"
	| "copy_path"
	| "copy_text"
	| "back";

interface TodoOverlayOptions {
	tui: TodoOverlayScheduler;
	store: TodoStore;
	who: WhoAmI;
	onCancel: () => void;
}

export interface TodoOverlayScheduler {
	requestRender(): void;
}

/**
 * /todos overlay (MVP): search + grouped list + action menu.
 *
 * This component is focused as a whole and delegates key handling internally.
 */
export class TodoOverlayComponent extends Container {
	private readonly tui: TodoOverlayScheduler;
	private readonly store: TodoStore;
	private readonly who: WhoAmI;
	private readonly onCancel: () => void;

	private mode: OverlayMode = "list";
	private error: string | null = null;

	private readonly searchInput: Input;
	private readonly listContainer: Container;
	private readonly appendEditor: Editor;

	private todos: TodoRecord[] = [];
	private rows: TodoDisplayRow[] = [];
	private selectedRowIndex = 0;
	private selectedActionIndex = 0;

	constructor(options: TodoOverlayOptions) {
		super();
		this.tui = options.tui;
		this.store = options.store;
		this.who = options.who;
		this.onCancel = options.onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("/todos"), 1, 0));
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.searchInput.onSubmit = () => {
			// Enter selects current row, not the input.
			this.openActionsIfPossible();
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.appendEditor = new Editor(getEditorTheme());
		this.appendEditor.onSubmit = async (text) => {
			const todo = this.getSelectedTodo();
			if (!todo) {
				this.mode = "list";
				this.renderList();
				this.tui.requestRender();
				return;
			}
			try {
				await this.store.append(todo.frontmatter.id, { markdown: text, who: this.who });
				await this.reload();
				this.mode = "actions";
				this.renderActions();
			} catch (err: unknown) {
				this.error = err instanceof Error ? err.message : String(err);
				this.mode = "list";
				this.renderList();
			}
			this.tui.requestRender();
		};

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		// Initial load
		this.reload().then(() => {
			this.showList();
			this.tui.requestRender();
		});
	}

	/** Make the list view visible (used by TUIRenderer + tests). */
	showList(): void {
		this.mode = "list";
		this.renderList();
	}

	invalidate(): void {
		// Container children handle invalidate.
		super.invalidate();
	}

	private getSelectedTodo(): TodoRecord | null {
		const row = this.rows[this.selectedRowIndex];
		return row?.kind === "todo" ? row.todo : null;
	}

	private tokenize(query: string): string[] {
		return query
			.trim()
			.toLowerCase()
			.split(/\s+/)
			.filter((t) => t.length > 0);
	}

	private matchesSearch(todo: TodoRecord, query: string): boolean {
		const tokens = this.tokenize(query);
		if (tokens.length === 0) return true;
		const tagText = (todo.frontmatter.tags ?? []).join(" ");
		const searchText =
			`${todo.frontmatter.id} ${todo.frontmatter.title} ${todo.frontmatter.list} ${tagText}`.toLowerCase();
		return tokens.every((t) => searchText.includes(t));
	}

	private buildRows(query: string): TodoDisplayRow[] {
		const filtered = this.todos.filter((t) => this.matchesSearch(t, query));

		const assignedToMe = filtered.filter((t) => t.frontmatter.assigned_to_session === this.who.sessionId);
		const openUnassigned = filtered.filter(
			(t) =>
				(t.frontmatter.status === "open" || t.frontmatter.status === "in_progress") &&
				!t.frontmatter.assigned_to_session,
		);
		const closed = filtered.filter((t) => t.frontmatter.status === "done" || t.frontmatter.status === "cancelled");

		const rows: TodoDisplayRow[] = [];
		if (assignedToMe.length > 0) {
			rows.push({ kind: "header", label: "Assigned to me" });
			for (const t of assignedToMe) rows.push({ kind: "todo", todo: t });
		}
		if (openUnassigned.length > 0) {
			rows.push({ kind: "header", label: "Open / unassigned" });
			for (const t of openUnassigned) rows.push({ kind: "todo", todo: t });
		}
		if (closed.length > 0) {
			rows.push({ kind: "header", label: "Done / cancelled" });
			for (const t of closed) rows.push({ kind: "todo", todo: t });
		}

		if (rows.length === 0) {
			rows.push({ kind: "header", label: "No matching todos" });
		}

		return rows;
	}

	private clampSelection(): void {
		if (this.rows.length === 0) {
			this.selectedRowIndex = 0;
			return;
		}
		this.selectedRowIndex = Math.max(0, Math.min(this.selectedRowIndex, this.rows.length - 1));
		// If we landed on a header, move down to next todo if possible.
		if (this.rows[this.selectedRowIndex]?.kind === "header") {
			for (let i = this.selectedRowIndex + 1; i < this.rows.length; i++) {
				if (this.rows[i]?.kind === "todo") {
					this.selectedRowIndex = i;
					return;
				}
			}
			// Otherwise move up.
			for (let i = this.selectedRowIndex - 1; i >= 0; i--) {
				if (this.rows[i]?.kind === "todo") {
					this.selectedRowIndex = i;
					return;
				}
			}
		}
	}

	private renderList(): void {
		this.listContainer.clear();

		const query = this.searchInput.getValue();
		this.rows = this.buildRows(query);
		this.clampSelection();

		if (this.error) {
			this.listContainer.addChild(new Text(theme.fg("error", this.error), 1, 0));
			this.listContainer.addChild(new Spacer(1));
		}

		for (let i = 0; i < this.rows.length; i++) {
			const row = this.rows[i];
			if (!row) continue;

			if (row.kind === "header") {
				this.listContainer.addChild(new Text(theme.fg("muted", row.label), 1, 0));
				continue;
			}

			const todo = row.todo;
			const isSelected = i === this.selectedRowIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const status = theme.fg("dim", `[${todo.frontmatter.status}]`);
			const list = theme.fg("muted", `(${todo.frontmatter.list})`);
			const title = isSelected ? theme.fg("accent", todo.frontmatter.title) : todo.frontmatter.title;
			this.listContainer.addChild(new Text(`${prefix}${status} ${list} ${title}`, 1, 0));
		}

		this.listContainer.addChild(new Spacer(1));
		this.listContainer.addChild(new Text(theme.fg("dim", "↑/↓ navigate · enter actions · esc close"), 1, 0));
	}

	private openActionsIfPossible(): void {
		const todo = this.getSelectedTodo();
		if (!todo) return;
		this.mode = "actions";
		this.selectedActionIndex = 0;
		this.renderActions();
	}

	private getActions(todo: TodoRecord): TodoAction[] {
		const assignedToMe = todo.frontmatter.assigned_to_session === this.who.sessionId;
		const hasAssignment = Boolean(todo.frontmatter.assigned_to_session);
		const actions: TodoAction[] = ["view"];
		if (!hasAssignment || !assignedToMe) actions.push("claim");
		if (hasAssignment) actions.push("release");
		actions.push("mark_in_progress", "mark_done", "mark_cancelled", "append_note", "copy_path", "copy_text", "back");
		return actions;
	}

	private renderActions(): void {
		const todo = this.getSelectedTodo();
		if (!todo) {
			this.mode = "list";
			this.renderList();
			return;
		}

		this.listContainer.clear();
		this.listContainer.addChild(new Text(theme.bold(todo.frontmatter.title), 1, 0));
		this.listContainer.addChild(
			new Text(theme.fg("dim", `${todo.frontmatter.id} · ${todo.frontmatter.status}`), 1, 0),
		);
		this.listContainer.addChild(new Spacer(1));

		const actions = this.getActions(todo);
		this.selectedActionIndex = Math.max(0, Math.min(this.selectedActionIndex, actions.length - 1));

		for (let i = 0; i < actions.length; i++) {
			const a = actions[i];
			const isSelected = i === this.selectedActionIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			this.listContainer.addChild(new Text(prefix + this.formatActionLabel(a), 1, 0));
		}

		this.listContainer.addChild(new Spacer(1));
		this.listContainer.addChild(new Text(theme.fg("dim", "↑/↓ select · enter run · esc back"), 1, 0));
	}

	private formatActionLabel(action: TodoAction): string {
		switch (action) {
			case "view":
				return "view";
			case "claim":
				return "claim";
			case "release":
				return "release";
			case "mark_in_progress":
				return "mark in_progress";
			case "mark_done":
				return "mark done";
			case "mark_cancelled":
				return "mark cancelled";
			case "append_note":
				return "append note";
			case "copy_path":
				return "copy path";
			case "copy_text":
				return "copy text";
			case "back":
				return "back";
		}
	}

	private async runSelectedAction(): Promise<void> {
		const todo = this.getSelectedTodo();
		if (!todo) return;
		const actions = this.getActions(todo);
		const action = actions[this.selectedActionIndex];
		if (!action) return;

		try {
			switch (action) {
				case "view": {
					this.mode = "view";
					await this.renderView(todo);
					return;
				}
				case "claim": {
					await this.store.claim(todo.frontmatter.id, { who: this.who, force: false });
					break;
				}
				case "release": {
					await this.store.release(todo.frontmatter.id, { who: this.who, force: false });
					break;
				}
				case "mark_in_progress": {
					await this.store.update(todo.frontmatter.id, { status: "in_progress", who: this.who });
					break;
				}
				case "mark_done": {
					await this.store.update(todo.frontmatter.id, { status: "done", who: this.who });
					break;
				}
				case "mark_cancelled": {
					await this.store.update(todo.frontmatter.id, { status: "cancelled", who: this.who });
					break;
				}
				case "append_note": {
					this.mode = "append";
					this.listContainer.clear();
					this.listContainer.addChild(new Text(theme.fg("dim", "Append note (enter to submit)"), 1, 0));
					this.listContainer.addChild(new Spacer(1));
					this.listContainer.addChild(this.appendEditor);
					this.appendEditor.setText("");
					return;
				}
				case "copy_path": {
					copyToClipboard(todo.path);
					break;
				}
				case "copy_text": {
					const full = await this.store.get(todo.frontmatter.id);
					if (full) {
						copyToClipboard(formatTodoMarkdown({ frontmatter: full.frontmatter, body: full.body }));
					}
					break;
				}
				case "back": {
					this.mode = "list";
					this.renderList();
					this.tui.requestRender();
					return;
				}
			}
		} catch (err: unknown) {
			this.error = err instanceof Error ? err.message : String(err);
		}

		await this.reload();
		this.mode = "actions";
		this.renderActions();
		this.tui.requestRender();
	}

	private async renderView(todo: TodoRecord): Promise<void> {
		this.listContainer.clear();
		this.listContainer.addChild(new Text(theme.bold(todo.frontmatter.title), 1, 0));
		this.listContainer.addChild(
			new Text(
				theme.fg("dim", `${todo.frontmatter.id} · ${todo.frontmatter.status} · ${todo.frontmatter.list}`),
				1,
				0,
			),
		);
		this.listContainer.addChild(new Spacer(1));

		const body = todo.body.trim().length > 0 ? todo.body.trimEnd() : theme.fg("muted", "(no notes)");
		for (const line of body.split("\n")) {
			this.listContainer.addChild(new Text(line, 1, 0));
		}
		this.listContainer.addChild(new Spacer(1));
		this.listContainer.addChild(new Text(theme.fg("dim", "esc back"), 1, 0));
	}

	async reload(): Promise<void> {
		try {
			this.error = null;
			this.todos = await this.store.list({ includeClosed: true }, this.who);
		} catch (err: unknown) {
			this.error = err instanceof Error ? err.message : String(err);
			this.todos = [];
		}
		this.rows = this.buildRows(this.searchInput.getValue());
		this.clampSelection();
	}

	handleInput(data: string): void {
		if (data === "\x1b") {
			if (this.mode === "list") {
				this.onCancel();
				return;
			}
			if (this.mode === "actions") {
				this.mode = "list";
				this.renderList();
				return;
			}
			if (this.mode === "view") {
				this.mode = "actions";
				this.renderActions();
				return;
			}
			if (this.mode === "append") {
				this.mode = "actions";
				this.renderActions();
				return;
			}
		}

		if (this.mode === "append") {
			this.appendEditor.handleInput?.(data);
			return;
		}

		if (data === "\x1b[A") {
			if (this.mode === "actions") {
				this.selectedActionIndex = Math.max(0, this.selectedActionIndex - 1);
				this.renderActions();
				return;
			}

			this.selectedRowIndex = Math.max(0, this.selectedRowIndex - 1);
			this.clampSelection();
			this.renderList();
			return;
		}
		if (data === "\x1b[B") {
			if (this.mode === "actions") {
				const todo = this.getSelectedTodo();
				if (!todo) return;
				const actions = this.getActions(todo);
				this.selectedActionIndex = Math.min(this.selectedActionIndex + 1, actions.length - 1);
				this.renderActions();
				return;
			}

			this.selectedRowIndex = Math.min(this.selectedRowIndex + 1, Math.max(0, this.rows.length - 1));
			this.clampSelection();
			this.renderList();
			return;
		}
		if (data === "\r") {
			if (this.mode === "list") {
				this.openActionsIfPossible();
				return;
			}
			if (this.mode === "actions") {
				void this.runSelectedAction();
				return;
			}
		}

		// Default: treat as search input update.
		if (this.mode === "list") {
			this.searchInput.handleInput(data);
			this.renderList();
		}
	}
}
