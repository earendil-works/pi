/// <reference lib="dom" />
// A page's plugin stylesheets (p3 step 0a; design §21, "UI on client hosts"): each plugin's `<link>` paired with the
// code it runs, the bootstrap's at first. An update fetches a plugin's new stylesheet inactive (`media="not all"`:
// loaded, not applied) right after the plugin's own before the reload, and applies it only when the plugin's new code
// was adopted; the old one goes once the page has drawn a frame after the reload. A stylesheet that did not load (or not
// in time) is loaded again by the next update; a stopped update removes what it prepared.

import type { ClientError, ClientStyles, ScriptEntry, ScriptSet } from "../surfaces/index.ts";

/**
 * The page's plugin stylesheets (`ClientStyles`). A plugin new to the page gets its stylesheet at its place in the set's
 * order, so the cascade between plugins stays. UI an object contributes and keeps until its successor is live (design
 * §21) may outlast the old stylesheet: it can show unstyled while that object restarts.
 */
export class PageStyles implements ClientStyles {
	/** The stylesheet of the code each plugin runs, by plugin. */
	readonly #current = new Map<string, Sheet>();
	/** The stylesheets fetched inactive for the update under way, by plugin. */
	readonly #prepared = new Map<string, Sheet>();
	readonly #report: (error: ClientError) => void;

	/**
	 * Takes the page's own links of the plugins' stylesheets (`initial`, by plugin) with how their loads ended so far
	 * (`ended`, by `href`, as the bootstrap recorded them).
	 */
	constructor(
		initial: Readonly<Record<string, string>>,
		ended: Readonly<Record<string, "load" | "error">>,
		report: (error: ClientError) => void,
	) {
		this.#report = report;
		const plugins = new Map(Object.entries(initial).map(([plugin, href]) => [href, plugin]));
		for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
			const href = link.getAttribute("href") ?? "";
			const plugin = plugins.get(href);
			if (plugin !== undefined) this.#current.set(plugin, Sheet.present(link, href, ended[href]));
		}
	}

	async prepare(set: ScriptSet, signal: AbortSignal): Promise<void> {
		const waits: Promise<void>[] = [];
		for (const [index, { name, css }] of set.plugins.entries()) {
			if (css === undefined || this.#current.get(name)?.loadedFrom(css) === true) {
				this.#drop(name);
				continue;
			}
			let sheet = this.#prepared.get(name);
			if (sheet === undefined || !sheet.usableFor(css)) {
				this.#drop(name);
				sheet = Sheet.inactive(css);
				this.#insert(sheet.link, name, set.plugins.slice(0, index), set.plugins.slice(index + 1));
				this.#prepared.set(name, sheet);
			}
			waits.push(
				sheet.wait(signal).then((outcome) => {
					if (outcome.kind === "failed") {
						this.#report({ kind: "stylesheet_failed", plugin: name, url: css, reason: outcome.reason });
					}
				}),
			);
		}
		await Promise.all(waits);
		// Stopped: nothing it prepared will be adopted, and a request finishing later must change nothing.
		if (signal.aborted) for (const name of [...this.#prepared.keys()]) this.#drop(name);
	}

	settle(set: ScriptSet, kept: ReadonlySet<string>): void {
		const retired: Sheet[] = [];
		const names = new Set(set.plugins.map(({ name }) => name));
		for (const { name, css } of set.plugins) {
			const prepared = this.#prepared.get(name);
			this.#prepared.delete(name);
			const current = this.#current.get(name);
			if (kept.has(name)) prepared?.remove();
			else if (prepared !== undefined) {
				prepared.activate();
				if (current !== undefined) retired.push(current);
				this.#current.set(name, prepared);
			} else if (css === undefined && current !== undefined) {
				retired.push(current);
				this.#current.delete(name);
			}
		}
		for (const sheet of this.#prepared.values()) sheet.remove();
		this.#prepared.clear();
		for (const [name, sheet] of this.#current) {
			if (names.has(name)) continue;
			retired.push(sheet);
			this.#current.delete(name);
		}
		// The new code renders after the reload resolved (its registries notify, React commits): the old rules stay
		// until the page drew a frame after the reload (UI an object keeps until its successor is live may outlast them).
		if (retired.length > 0) {
			afterDrawn(() => {
				for (const sheet of retired) sheet.remove();
			});
		}
	}

	/** Removes plugin `name`'s prepared stylesheet, if it has one. */
	#drop(name: string): void {
		this.#prepared.get(name)?.remove();
		this.#prepared.delete(name);
	}

	/**
	 * Inserts `link` of `plugin` right after the plugin's own link, else after the last link of the nearest plugin
	 * `before` it in the set's order, else before the first link of a plugin `after` it, else at the end of the head.
	 */
	#insert(link: HTMLLinkElement, plugin: string, before: readonly ScriptEntry[], after: readonly ScriptEntry[]): void {
		const own = this.#current.get(plugin)?.link;
		const previous = [...before]
			.reverse()
			.map(({ name }) => (this.#prepared.get(name) ?? this.#current.get(name))?.link)
			.find((each) => each !== undefined);
		const next = after
			.map(({ name }) => (this.#current.get(name) ?? this.#prepared.get(name))?.link)
			.find((each) => each !== undefined);
		if (own !== undefined) own.after(link);
		else if (previous !== undefined) previous.after(link);
		else if (next !== undefined) next.before(link);
		else document.head.append(link);
	}
}

/** How long an update waits for a new stylesheet before it reloads its plugin anyway: 10 s. */
const STYLESHEET_WAIT_MS = 10_000;

/** What became of a stylesheet's load within an update's wait. */
type LoadOutcome =
	| { readonly kind: "loaded" }
	| { readonly kind: "failed"; readonly reason: "error" | "timeout" }
	| { readonly kind: "cancelled" };

/** Where a stylesheet's load is: under way (also past a wait's 10 s), loaded, or failed. */
type LoadState = "loading" | "loaded" | "failed";

/**
 * One plugin stylesheet's `<link>` and its load's state, followed while the link is in the page: a load finishing after a
 * wait gave up still counts.
 */
class Sheet {
	readonly link: HTMLLinkElement;
	readonly href: string;
	#state: LoadState;
	/** Waits listening for the load's end (or the link's removal). */
	readonly #waiting = new Set<(outcome: LoadOutcome) => void>();
	/** Ends the link's listeners when it is removed. */
	readonly #listening = new AbortController();

	private constructor(link: HTMLLinkElement, href: string, state: LoadState) {
		this.link = link;
		this.href = href;
		this.#state = state;
		if (state !== "loading") return;
		const settle = (next: "loaded" | "failed"): void => {
			this.#state = next;
			this.#wake(next === "loaded" ? { kind: "loaded" } : { kind: "failed", reason: "error" });
		};
		link.addEventListener("load", () => settle("loaded"), { signal: this.#listening.signal });
		link.addEventListener("error", () => settle("failed"), { signal: this.#listening.signal });
	}

	/** A new `<link>` for `href`, fetched but not applied (`media="not all"`) until `activate`; not inserted yet. */
	static inactive(href: string): Sheet {
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.media = "not all";
		const sheet = new Sheet(link, href, "loading");
		link.href = href;
		return sheet;
	}

	/**
	 * A `<link>` the page came with, at `href`, its load `ended` as the bootstrap saw it (`undefined`: still under way,
	 * followed from now). Not its `sheet`: a failed load (an HTTP error) still has one, empty.
	 */
	static present(link: HTMLLinkElement, href: string, ended: "load" | "error" | undefined): Sheet {
		return new Sheet(link, href, ended === "load" ? "loaded" : ended === "error" ? "failed" : "loading");
	}

	/** Whether it loaded from `href`: an update with that stylesheet has nothing to load. */
	loadedFrom(href: string): boolean {
		return this.href === href && this.#state === "loaded";
	}

	/** Whether an update with stylesheet `href` can wait for it rather than fetch again: the same, and not failed. */
	usableFor(href: string): boolean {
		return this.href === href && this.#state !== "failed";
	}

	/** Its load's outcome: at once when it ended, else when it ends, after 10 s (`timeout`), or when `signal` aborts. */
	wait(signal: AbortSignal): Promise<LoadOutcome> {
		return new Promise((resolve) => {
			const done = (outcome: LoadOutcome): void => {
				clearTimeout(timer);
				signal.removeEventListener("abort", aborted);
				this.#waiting.delete(done);
				resolve(outcome);
			};
			const aborted = (): void => done({ kind: "cancelled" });
			const timer = setTimeout(() => done({ kind: "failed", reason: "timeout" }), STYLESHEET_WAIT_MS);
			if (signal.aborted) aborted();
			else if (this.#state === "loaded") done({ kind: "loaded" });
			else if (this.#state === "failed") done({ kind: "failed", reason: "error" });
			else {
				this.#waiting.add(done);
				signal.addEventListener("abort", aborted, { once: true });
			}
		});
	}

	/** Applies it (it was fetched inactive). */
	activate(): void {
		this.link.removeAttribute("media");
	}

	/** Takes it out of the page and stops following its load (its waits end `cancelled`). */
	remove(): void {
		this.#listening.abort();
		this.#wake({ kind: "cancelled" });
		this.link.remove();
	}

	/** Ends every wait with `outcome`. */
	#wake(outcome: LoadOutcome): void {
		for (const done of [...this.#waiting]) done(outcome);
	}
}

/** Runs `fn` once the page has drawn a frame after the current task (the next frame's callbacks run before it paints). */
function afterDrawn(fn: () => void): void {
	setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(fn)), 0);
}
