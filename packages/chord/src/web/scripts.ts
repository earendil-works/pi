/// <reference lib="dom" />
// A page's plugin scripts (slice 11 §2, decision "Slice 11's points" (P2)): scripts that register themselves through
// `chordFacet`, loaded with `<script src>` (no `eval` under the page's CSP). The combined file's scripts ran before the
// base bundle and queued (the page's bootstrap); later ones are fetched one each and resolve the fetch that asked for
// them. The plugins' stylesheets follow the applied set.

import type { FacetFunction, RegisteredScript, ScriptEntry, ScriptSet } from "../surfaces/index.ts";
import { REGISTER } from "../surfaces/index.ts";

/** What the page's bootstrap left: the base bundle's hash and the scripts the combined file registered. */
export type PageBootstrap = {
	readonly base: string;
	readonly queued: readonly (readonly [string, string, FacetFunction])[];
};

/** The page's plugin scripts: those the page started with, and fetches of later ones. */
export class PageScripts {
	/** Fetches waiting for their script to register, by plugin and digest. */
	readonly #waiting = new Map<string, (script: RegisteredScript) => void>();
	readonly initial: readonly RegisteredScript[];
	readonly base: string;

	constructor(bootstrap: PageBootstrap) {
		this.base = bootstrap.base;
		this.initial = bootstrap.queued.map(([plugin, digest, run]) => ({ plugin, digest, run }));
		// From now on a script that registers resolves its fetch.
		(globalThis as Record<string, unknown>)[REGISTER] = (plugin: string, digest: string, run: FacetFunction) => {
			this.#waiting.get(`${plugin}\0${digest}`)?.({ plugin, digest, run });
		};
	}

	/** Loads `entry`'s script with a `<script src>`; resolves once it registered, rejects when it does not load. */
	fetch(entry: ScriptEntry): Promise<RegisteredScript> {
		const key = `${entry.name}\0${entry.digest}`;
		return new Promise<RegisteredScript>((resolve, reject) => {
			const element = document.createElement("script");
			const done = (): void => {
				this.#waiting.delete(key);
				element.remove();
			};
			this.#waiting.set(key, (script) => {
				done();
				resolve(script);
			});
			element.addEventListener("error", () => {
				done();
				reject(new Error(`plugin "${entry.name}": its script ${entry.url} did not load`));
			});
			// A script that loaded without registering (a wrong file) never resolves its own key: refused on load.
			element.addEventListener("load", () => {
				if (!this.#waiting.has(key)) return;
				done();
				reject(new Error(`plugin "${entry.name}": ${entry.url} did not register ${entry.digest}`));
			});
			element.src = entry.url;
			document.head.append(element);
		});
	}
}

/**
 * Makes the page's plugin stylesheets those of `set`: a new one added, one no longer in it removed (the base bundle's
 * and the app's own stylesheets untouched).
 */
export function syncStylesheets(set: ScriptSet, prefix: string): void {
	const wanted = new Set(set.plugins.flatMap(({ css }) => (css === undefined ? [] : [css])));
	const links = document.querySelectorAll<HTMLLinkElement>(`link[rel="stylesheet"][href^="${prefix}plugin/"]`);
	for (const link of links) {
		const href = link.getAttribute("href") ?? "";
		if (wanted.has(href)) wanted.delete(href);
		else link.remove();
	}
	for (const href of wanted) {
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = href;
		document.head.append(link);
	}
}
