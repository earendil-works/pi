// Overlays for the web-parity panels (p2-tui-port.md P11): a filterable list with per-row actions, in the look of
// pi's selectors (borders, `→` cursor, dim hints), and a yes/no confirmation. Rows are server data: callers pass text
// through `lineText`/`safeText`; the overlay sanitizes again.
import {
	type Component,
	type Focusable,
	fuzzyFilter,
	Input,
	type KeyId,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { TuiContext } from "../../runtime/tui-context.ts";
import { lineText } from "../render-context.ts";
import type { SelectorContext } from "./selectors.ts";

export type ListRow = {
	key: string;
	label: string;
	/** Right-aligned, dim. */
	detail?: string;
	/** Below the list for the selected row (wrapped to one line here). */
	description?: string;
	color?: "accent" | "muted" | "warning" | "error" | "success";
};
export type ListAction = {
	/** A binding id (`app.session.delete`), matched through the keymap (rebindable). */
	id?: string;
	/** Or a fixed key of this panel (`ctrl+t`), matched literally. */
	key?: KeyId;
	label: string;
	run(row: ListRow | undefined): void;
};

export class ListOverlay implements Component, Focusable {
	focused = false;
	private readonly ctx: SelectorContext;
	private readonly input = new Input();
	private readonly title: () => string;
	private readonly rows: () => readonly ListRow[];
	private readonly actions: readonly ListAction[];
	private readonly onSelect: ((row: ListRow) => void) | undefined;
	private readonly onClose: () => void;
	private readonly height: number;
	private readonly footer: (() => string[]) | undefined;
	private selected = 0;
	private selectedKey: string | undefined;
	/** Keeps the last row selected while the reader stays on it (a log tail). */
	private follow: boolean;
	private readonly followable: boolean;
	constructor(
		ctx: SelectorContext,
		options: {
			title: string | (() => string);
			rows: () => readonly ListRow[];
			actions?: readonly ListAction[];
			onSelect?: (row: ListRow) => void;
			onClose: () => void;
			height?: number;
			/** Lines under the list (status, the selected row's details). */
			footer?: () => string[];
			/** Preselects this row. */
			selected?: string;
			/** Selects the last row and keeps following new ones while it stays selected. */
			follow?: boolean;
		},
	) {
		this.follow = options.follow ?? false;
		this.followable = this.follow;
		this.ctx = ctx;
		this.title = typeof options.title === "string" ? () => options.title as string : options.title;
		this.rows = options.rows;
		this.actions = options.actions ?? [];
		this.onSelect = options.onSelect;
		this.onClose = options.onClose;
		this.height = options.height ?? 12;
		this.footer = options.footer;
		this.selectedKey = options.selected;
	}
	private filtered(): readonly ListRow[] {
		const query = this.input.getValue();
		const rows = this.rows();
		return query ? fuzzyFilter([...rows], query, (row) => `${row.label} ${row.detail ?? ""}`) : rows;
	}
	/** The selected row follows its key when rows change. */
	private current(rows: readonly ListRow[]): number {
		if (this.follow) this.selected = rows.length - 1;
		else if (this.selectedKey !== undefined) {
			const index = rows.findIndex((row) => row.key === this.selectedKey);
			// A key not listed yet (rows still loading) stays the choice until it is.
			if (index < 0) return Math.max(0, Math.min(this.selected, rows.length - 1));
			this.selected = index;
		}
		this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
		this.selectedKey = rows[this.selected]?.key;
		return this.selected;
	}
	handleInput(data: string): void {
		const keys = this.ctx.keys;
		const rows = this.filtered();
		const index = this.current(rows);
		const move = (delta: number) => {
			if (!rows.length) return;
			this.selected = (index + delta + rows.length) % rows.length;
			this.selectedKey = rows[this.selected]?.key;
			this.follow = this.followable && this.selected === rows.length - 1;
		};
		if (keys.matches(data, "tui.select.up")) move(-1);
		else if (keys.matches(data, "tui.select.down")) move(1);
		else if (keys.matches(data, "tui.select.pageUp")) move(-Math.min(index, this.height));
		else if (keys.matches(data, "tui.select.pageDown")) move(Math.min(rows.length - 1 - index, this.height));
		else if (keys.matches(data, "tui.select.cancel")) this.onClose();
		else if (keys.matches(data, "tui.select.confirm")) {
			const row = rows[index];
			if (row && this.onSelect) this.onSelect(row);
		} else {
			const action = this.actions.find((candidate) =>
				candidate.id ? keys.matches(data, candidate.id) : candidate.key ? matchesKey(data, candidate.key) : false,
			);
			if (action) action.run(rows[index]);
			else {
				this.input.handleInput(data);
				this.selected = 0;
				this.selectedKey = undefined;
			}
		}
		this.ctx.requestRender();
	}
	render(width: number): string[] {
		const theme = this.ctx.theme.current;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const rows = this.filtered();
		const index = this.current(rows);
		const start = Math.max(0, Math.min(index - Math.floor(this.height / 2), rows.length - this.height));
		this.input.focused = this.focused;
		const lines = [border, truncateToWidth(theme.bold(this.title()), width), ...this.input.render(width), ""];
		for (const [offset, row] of rows.slice(start, start + this.height).entries()) {
			const selected = start + offset === index;
			const cursor = selected ? theme.fg("accent", "→ ") : "  ";
			const detail = row.detail ? theme.fg("dim", lineText(row.detail)) : "";
			const label = truncateToWidth(lineText(row.label), Math.max(8, width - 4 - visibleWidth(detail)), "…");
			const styled = row.color ? theme.fg(row.color, label) : selected ? theme.fg("accent", label) : label;
			const left = `${cursor}${styled}`;
			lines.push(
				truncateToWidth(
					`${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(detail)))}${detail}`,
					width,
				),
			);
		}
		if (rows.length === 0) lines.push(theme.fg("muted", "  Nothing here"));
		else if (start > 0 || start + this.height < rows.length)
			lines.push(theme.fg("muted", `  (${index + 1}/${rows.length})`));
		const description = rows[index]?.description;
		if (description) lines.push("", truncateToWidth(theme.fg("muted", `  ${lineText(description)}`), width, "…"));
		// Footer notes wrap (an explanation, a status); at most three lines each.
		for (const line of this.footer?.() ?? [])
			lines.push(
				...wrapTextWithAnsi(line, Math.max(10, width))
					.slice(0, 3)
					.map((part) => truncateToWidth(part, width, "…")),
			);
		const hints = [
			...(this.onSelect ? [`${this.ctx.keyText("tui.select.confirm")} open`] : []),
			...this.actions.map(
				(action) => `${action.id ? this.ctx.keyText(action.id) || action.id : (action.key ?? "")} ${action.label}`,
			),
			`${this.ctx.keyText("tui.select.cancel")} close`,
		];
		lines.push(truncateToWidth(theme.fg("dim", `  ${hints.join(" · ")}`), width, "…"), border);
		return lines;
	}
	invalidate(): void {
		this.input.invalidate();
	}
}

/** A yes/no question drawn by the worker (server actions, not launcher grants): Enter or y confirms. */
export class ConfirmOverlay implements Component, Focusable {
	focused = false;
	private readonly ctx: SelectorContext;
	private readonly lines: string[];
	private readonly onAnswer: (yes: boolean) => void;
	constructor(ctx: SelectorContext, lines: string[], onAnswer: (yes: boolean) => void) {
		this.ctx = ctx;
		this.lines = lines;
		this.onAnswer = onAnswer;
	}
	handleInput(data: string): void {
		if (this.ctx.keys.matches(data, "tui.select.confirm") || data === "y" || data === "Y") this.onAnswer(true);
		else if (this.ctx.keys.matches(data, "tui.select.cancel") || data === "n" || data === "N") this.onAnswer(false);
	}
	render(width: number): string[] {
		const theme = this.ctx.theme.current;
		const border = theme.fg("warning", "─".repeat(Math.max(1, width)));
		return [
			border,
			...this.lines.map((line, index) => truncateToWidth(index === 0 ? theme.bold(line) : line, width, "…")),
			truncateToWidth(
				theme.fg(
					"dim",
					`  ${this.ctx.keyText("tui.select.confirm")}/y confirm · ${this.ctx.keyText("tui.select.cancel")}/n cancel`,
				),
				width,
			),
			border,
		];
	}
	invalidate(): void {}
}

/** Shows a confirmation overlay and resolves with the answer. */
export function confirm(ctx: TuiContext, lines: string[]): Promise<boolean> {
	return new Promise((resolve) => {
		const handle = ctx.overlay(
			"confirm",
			new ConfirmOverlay(ctx, lines, (yes) => {
				handle.close();
				resolve(yes);
			}),
			{ width: "80%", anchor: "center" },
		);
	});
}

/** A read-only text panel (file contents, a diff): scrolls by line and page, opens at `line` (1-based). */
export class TextViewer implements Component, Focusable {
	focused = false;
	private readonly ctx: SelectorContext;
	private readonly title: string;
	/** Lines for a width (Markdown wraps); called on render and with the last width on input. */
	private readonly lines: (width: number) => readonly string[];
	private width = 80;
	private readonly onClose: () => void;
	private offset: number;
	private readonly rows: number;
	constructor(
		ctx: SelectorContext,
		options: {
			title: string;
			lines: (width: number) => readonly string[];
			onClose: () => void;
			line?: number;
			height?: number;
		},
	) {
		this.ctx = ctx;
		this.title = options.title;
		this.lines = options.lines;
		this.onClose = options.onClose;
		this.rows = options.height ?? 20;
		this.offset = Math.max(0, (options.line ?? 1) - 1 - 3);
	}
	private height(): number {
		return this.rows;
	}
	handleInput(data: string): void {
		const keys = this.ctx.keys;
		const max = Math.max(0, this.lines(this.width).length - this.height());
		if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "tui.select.confirm")) this.onClose();
		else if (keys.matches(data, "tui.select.up")) this.offset = Math.max(0, this.offset - 1);
		else if (keys.matches(data, "tui.select.down")) this.offset = Math.min(max, this.offset + 1);
		else if (keys.matches(data, "tui.select.pageUp")) this.offset = Math.max(0, this.offset - this.height());
		else if (keys.matches(data, "tui.select.pageDown")) this.offset = Math.min(max, this.offset + this.height());
		this.ctx.requestRender();
	}
	render(width: number): string[] {
		const theme = this.ctx.theme.current;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		this.width = width;
		const all = this.lines(width);
		this.offset = Math.min(this.offset, Math.max(0, all.length - this.height()));
		const visible = all.slice(this.offset, this.offset + this.height());
		return [
			border,
			truncateToWidth(theme.bold(lineText(this.title)), width, "…"),
			...visible.map((line) => truncateToWidth(line, width, "…")),
			truncateToWidth(
				theme.fg(
					"dim",
					`  ${this.offset + 1}-${this.offset + visible.length} of ${all.length} · ↑↓ PgUp/PgDn · ${this.ctx.keyText("tui.select.cancel")} closes`,
				),
				width,
			),
			border,
		];
	}
	invalidate(): void {}
}
