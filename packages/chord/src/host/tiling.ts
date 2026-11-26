// A list's pages (slice 14 §4): the tiling of a query's order between fixed bookmarks. Page 1 is `(start, b1]`,
// page 2 `(b1, b2]`, and the last page is open at its end while no row is known behind it. Each page is one read of
// the open query; pages are cut and merged when their runs are adopted, from the rows just read, with no I/O, so no
// frame loses a loaded row.

import type { Context } from "../context/index.ts";
import { compareScalar } from "../store/evaluate.ts";
import { OpenQuery, type OpenRead, type ReadSite } from "../store/open-query.ts";
import type { ReadRun } from "../store/read.ts";
import type { Position, Range, StoredRead } from "../store/read-plan.ts";
import type { Scalar } from "../store/rows.ts";
import type { LiveTarget } from "../store/shared-read.ts";
import type { Order } from "../store/sql.ts";

/** One page: the rows after `after` through `through` (the last page has none: it is open at its end). */
type Page = {
	readonly after: Position | undefined;
	readonly through: Position | undefined;
	readonly read: OpenRead;
	/** Its rows as its last run (or the cut that made it) left them; `undefined` until its first run. */
	rows: readonly StoredRead[] | undefined;
	/** Whether rows of its range are unread behind `rows`: its run was cut by its limit. */
	more: boolean;
	/** Why its last run could not read it, until a run of it succeeds. */
	failure: { readonly error: unknown } | undefined;
};

/** How many rows a bounded page reads at most, in pages (slice 14 §4 "Overflow"). */
const MAX_PAGES = 4;

/** Who a tiling tells: its list. */
export type TilingOwner = {
	/** A run was adopted; called inside a batch. */
	adopted(): void;
	/**
	 * A binding of its query changed (a set moved, its table ready after a migration): rows and their order may be
	 * others in every page. Its pages are not read again one by one (the first adoption would cut and merge the others
	 * with the rows they had); its list reads the target again as one new tiling.
	 */
	rebound(): void;
};

/**
 * The pages of a list for one target (a query and its arguments): one open query, a read of it per page, the rows
 * each returned, and the tiling rules.
 */
export class Tiling {
	readonly target: LiveTarget;
	readonly #query: OpenQuery;
	readonly #first: number;
	readonly #order: Order;
	readonly #owner: TilingOwner;
	#pages: Page[] = [];

	constructor(site: ReadSite, target: LiveTarget, first: number, owner: TilingOwner, context: Context) {
		this.target = target;
		this.#query = new OpenQuery(site, target.spec, "rows", owner, context);
		this.#first = first;
		this.#order = target.spec.query.order;
		this.#owner = owner;
	}

	/** What bookmarks of this tiling are positions of: the table, the order's columns and its direction. */
	get signature(): string {
		return JSON.stringify([this.target.spec.table, this.#order.columns, this.#order.direction]);
	}

	/** The bookmarks: the upper bound of every bounded page. */
	get bookmarks(): Position[] {
		return this.#pages.flatMap(({ through }) => (through === undefined ? [] : [through]));
	}

	/** Whether the last page is open at its end: no row is known behind what the list shows. */
	get open(): boolean {
		return this.#pages.at(-1)?.through === undefined;
	}

	/** Whether rows may follow what `rows` gives: a bounded last page, or a page that has not run yet. */
	get moreAfter(): boolean {
		return !this.open || !this.complete;
	}

	/** Whether every page has run. */
	get complete(): boolean {
		return this.#pages.every((page) => page.rows !== undefined);
	}

	/** The failure of the first page whose last run failed: the list is failed while any page is. */
	get failure(): { readonly error: unknown } | undefined {
		return this.#pages.find((page) => page.failure !== undefined)?.failure;
	}

	/**
	 * Whether its query was closed under it: its provider's attempt ended (slice 14 §3.2). It keeps its rows and
	 * loads nothing; the list reads the successor's query next.
	 */
	get retired(): boolean {
		return this.#query.closed;
	}

	/** The context its rows are decoded under: its query's. */
	get context(): Context {
		return this.#query.context;
	}

	/**
	 * The loaded rows in order, up to the first page that has none yet: a prefix, never a hole. Only read (its list
	 * decodes them): the rows of a list's only loaded page are that page's own, not copied (most lists have one).
	 */
	rows(): readonly StoredRead[] {
		const pages = this.#pages;
		const first = pages[0]?.rows;
		if (first !== undefined && (pages.length === 1 || pages[1]!.rows === undefined)) return first;
		// Counted first and copied by index: a page spread into `push` overflowed the stack past ~120,000 rows; this is
		// also faster (2 pages of 50 rows: 110 ns against 235 ns, 20 pages: 1.0 us against 2.3 us).
		let count = 0;
		let loaded = 0;
		for (; loaded < pages.length; loaded++) {
			const rows = pages[loaded]!.rows;
			if (rows === undefined) break;
			count += rows.length;
		}
		const rows: StoredRead[] = new Array(count);
		let at = 0;
		for (let index = 0; index < loaded; index++) {
			// The first `loaded` pages have rows (counted above).
			const page = pages[index]!.rows!;
			for (let row = 0; row < page.length; row++) rows[at++] = page[row]!;
		}
		return rows;
	}

	/**
	 * Opens a page per bookmark, and the open last page when the list ended in one, and resolves once each load
	 * settled. No bookmarks: one open page, the first.
	 */
	async start(bookmarks: readonly Position[], open: boolean): Promise<void> {
		let after: Position | undefined;
		for (const through of bookmarks) {
			this.#pages.push(this.#page(after, through));
			after = through;
		}
		if (open || bookmarks.length === 0) this.#pages.push(this.#page(after, undefined));
		await Promise.all(this.#pages.map((page) => page.read.load()));
	}

	/** Loads the next page behind a bounded last page; with an open last page there is nothing more to load. */
	async more(): Promise<void> {
		const last = this.#pages.at(-1);
		if (last === undefined || last.through === undefined) return;
		const page = this.#page(last.through, undefined);
		this.#pages.push(page);
		await page.read.load();
	}

	/** Closes its query: no commit runs its pages again. */
	close(): void {
		this.#query.close();
		this.#pages = [];
	}

	/** A page of `(after, through]` that has not run: its read is registered, a load or a commit runs it. */
	#page(after: Position | undefined, through: Position | undefined): Page {
		const sink = { adopt: (run: ReadRun): void => this.#adopt(page, run) };
		const read = this.#query.read({ kind: "rows", range: this.#range(after, through) }, sink);
		const page: Page = { after, through, rows: undefined, more: false, failure: undefined, read };
		return page;
	}

	/** A page of `(after, through]` whose rows are known (a cut, a merge): its read runs nothing. */
	#pageOf(after: Position | undefined, through: Position | undefined, rows: readonly StoredRead[]): Page {
		const sink = { adopt: (run: ReadRun): void => this.#adopt(page, run) };
		const read = this.#query.readKnown(this.#range(after, through), rows, sink);
		const page: Page = { after, through, rows, more: false, failure: undefined, read };
		return page;
	}

	/** The range a page of `(after, through]` reads. */
	#range(after: Position | undefined, through: Position | undefined): Range {
		// The open last page reads one page; a bounded one everything between its bookmarks, up to the overflow bound.
		const limit = through === undefined ? this.#first : this.#first * MAX_PAGES;
		return { ...(after === undefined ? {} : { after }), ...(through === undefined ? {} : { through }), limit };
	}

	/**
	 * Takes a page's run, inside a batch. A run belongs to the interval it read, not to a page (slice 14 §4): the
	 * runs of one commit, and of a commit group, are all computed before any is adopted, and an earlier adoption may
	 * have cut or merged the page meanwhile. The run then applies to whatever pages cover its interval now.
	 */
	#adopt(page: Page, run: ReadRun): void {
		const current = this.#pages.includes(page);
		if (run.kind !== "rows") {
			// A page's read is never a count. The pages that show the interval are failed until a run of them succeeds;
			// a page that did not run itself forgets its result, so the next commit over its tables runs it.
			const failure = { error: run.kind === "failed" ? run.error : new Error("a list's page took a count") };
			for (const each of current ? [page] : this.#pages.filter((other) => this.#overlap(other, page))) {
				each.failure = failure;
				each.read.forget();
			}
			this.#owner.adopted();
			return;
		}
		const { rows, more } = run.result;
		if (current) {
			page.rows = rows;
			page.more = more;
			page.failure = undefined;
		} else this.#patch(page, rows, more);
		this.#retile();
		this.#owner.adopted();
	}

	/**
	 * Applies the run of a retired page (`rows` of its interval; `more`: the run was cut by its limit, so the interval
	 * is known only through its last row) to the pages that cover the interval now. Each patched page's read is told
	 * its rows again: the skip test reasons from the keys of what the page shows. A failed page takes the rows and
	 * stays without a result, so the next commit over its tables runs it, whatever it writes. A page that lies behind
	 * what a cut run knows is loaded again; one the cut falls into keeps the rows up to it, and `#retile` continues
	 * behind.
	 */
	#patch(retired: Page, rows: readonly StoredRead[], more: boolean): void {
		const known = more ? this.#position(rows.at(-1)!) : undefined;
		this.#pages = this.#pages.map((page) => {
			if (page.rows === undefined || !this.#overlap(page, retired)) return page;
			if (known !== undefined && page.after !== undefined && this.#compare(page.after, known) >= 0) {
				page.read.close();
				const again = this.#page(page.after, page.through);
				void again.read.load();
				return again;
			}
			const kept = page.rows.filter((row) => !this.#inside(this.#position(row), retired));
			const taken = rows.filter((row) => this.#inside(this.#position(row), page));
			const merged = [...kept, ...taken].sort((a, b) => this.#compare(this.#position(a), this.#position(b)));
			const cut = known !== undefined && (page.through === undefined || this.#compare(page.through, known) > 0);
			page.rows = cut ? merged.filter((row) => this.#compare(this.#position(row), known) <= 0) : merged;
			page.more = page.more || cut;
			if (page.failure === undefined) page.read.know(page.rows);
			return page;
		});
	}

	/**
	 * Cuts and merges, from the rows the pages hold, with no I/O. The open last page with a row behind it, or grown
	 * past one page, gets its bound at its last row (the list ends there until `more`); a bounded page past the
	 * overflow bound is cut and the rest of its range loads next; a page of more than two pages' rows is cut into
	 * pages; neighbours with at most one page's rows together become one.
	 */
	#retile(): void {
		const first = this.#first;
		const pages: Page[] = [];
		for (const page of this.#pages) {
			const rows = page.rows;
			const open = page.through === undefined;
			const full = rows !== undefined && (page.more || rows.length > (open ? first : 2 * first));
			if (rows === undefined || page.failure !== undefined || !full) {
				pages.push(page);
				continue;
			}
			page.read.close();
			// Rows of a bounded page's range are still unread behind `rows` (overflow): the rest loads as a page of its own.
			const unread = !open && page.more;
			const through = open ? this.#position(rows.at(-1)!) : page.through;
			let after = page.after;
			for (let from = 0; from < rows.length; from += first) {
				// The last cut takes what is left when that is at most two pages' rows, and ends where the page did.
				const last = rows.length - from <= 2 * first;
				const chunk = last ? rows.slice(from) : rows.slice(from, from + first);
				const end = last && !unread ? through : this.#position(chunk.at(-1)!);
				pages.push(this.#pageOf(after, end, chunk));
				after = end;
				if (last) break;
			}
			if (unread) {
				const rest = this.#page(after, page.through);
				pages.push(rest);
				void rest.read.load();
			}
		}
		this.#pages = this.#merged(pages);
	}

	/** `pages` with neighbours that hold at most one page's rows together merged into one. */
	#merged(pages: readonly Page[]): Page[] {
		const merged: Page[] = [];
		for (const page of pages) {
			const previous = merged.at(-1);
			if (previous === undefined || !this.#mergeable(previous) || !this.#mergeable(page)) {
				merged.push(page);
				continue;
			}
			const rows = [...previous.rows!, ...page.rows!];
			if (rows.length > this.#first) {
				merged.push(page);
				continue;
			}
			previous.read.close();
			page.read.close();
			merged[merged.length - 1] = this.#pageOf(previous.after, page.through, rows);
		}
		return merged;
	}

	/** Whether `page` may merge with a neighbour: every row of its range is known. */
	#mergeable(page: Page): boolean {
		return page.rows !== undefined && !page.more && page.failure === undefined;
	}

	/** Whether the intervals of two pages share a position. */
	#overlap(a: Pick<Page, "after" | "through">, b: Pick<Page, "after" | "through">): boolean {
		const before = (x: typeof a, y: typeof a): boolean =>
			x.through !== undefined && y.after !== undefined && this.#compare(x.through, y.after) <= 0;
		return !before(a, b) && !before(b, a);
	}

	/** Whether `position` is in `page`'s interval. */
	#inside(position: Position, { after, through }: Pick<Page, "after" | "through">): boolean {
		if (after !== undefined && this.#compare(position, after) <= 0) return false;
		return through === undefined || this.#compare(position, through) <= 0;
	}

	/** The position of `row` in the order: its order columns' values. */
	#position(row: StoredRead): Position {
		return this.#order.columns.map((name) => row[name]!);
	}

	/** Orders two positions as the list shows them: negative when `a` comes first. */
	#compare(a: Position, b: Position): number {
		for (let index = 0; index < a.length; index++) {
			// Order columns are non-`opt` `str` or `int` ones (checked when the query was built).
			const order = compareScalar(a[index] as Scalar, b[index] as Scalar);
			if (order !== 0) return this.#order.direction === "asc" ? order : -order;
		}
		return 0;
	}
}
