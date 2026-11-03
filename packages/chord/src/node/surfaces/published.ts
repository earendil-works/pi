// A client kind's published scripts (slice 11 §1, decisions "Slice 11, P3" and "P5"): what the server serves of the
// kind's plugins, as files under the surface's prefix, and the set its scripts object shows. Each plugin's facet is a
// script that registers itself (`<prefix>plugin/<plugin>.<digest>.js`, its stylesheet beside it), the whole set one
// combined file named by its hash (`<prefix>plugins.<hash>.js`), assets under `<prefix>assets/`; all named by their
// content, served forever. A rollout shipping the kind publishes a new set (a plugin whose new build failed keeps its
// last script) without waiting for clients; the files of the last few sets stay served for clients that still load
// them.

import { createHash } from "node:crypto";
import type { Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import type { Host, PluginFailure } from "../../host/index.ts";
import { registeredSource, type ScriptSet } from "../../surfaces/index.ts";
import type { Built, PluginScript, Plugins, RolloutStep } from "../plugins/index.ts";
import { publishTo, type SurfaceName } from "./current.ts";
import { CSS, JAVASCRIPT, mimeOf, type ServedFile } from "./served.ts";

/** How many sets' files stay served: the current one and the few before it, for clients loading them meanwhile. */
const KEPT_SETS = 4;

/** One plugin's published script: its digest, its registered text, its stylesheet. */
/**
 * One plugin's published script: its digest, its registered text, its stylesheet and assets (kept with the script: a
 * plugin whose next build fails keeps all three).
 */
type Published = {
	readonly digest: string;
	readonly text: string;
	readonly css: string | undefined;
	readonly assets: readonly { readonly name: string; readonly bytes: Uint8Array }[];
};

/** A script's inline source map comment. */
const SOURCE_MAP = /\n\/\/# sourceMappingURL=data:[^\n]*/g;

/** A client kind's published scripts. */
export class PublishedScripts<P extends Principal> {
	readonly #surface: SurfaceName;
	readonly #kind: string;
	readonly #prefix: string;
	readonly #base: string;
	readonly #plugins: Plugins;
	readonly #host: Host<P>;
	/** The published script of each plugin now. */
	readonly #current = new Map<string, Published>();
	/** The files of the last `KEPT_SETS` sets, newest last, each by path. */
	readonly #sets: ReadonlyMap<string, ServedFile>[] = [];
	#set: ScriptSet | undefined;

	constructor(surface: SurfaceName, kind: string, prefix: string, base: string, plugins: Plugins, host: Host<P>) {
		this.#surface = surface;
		this.#kind = kind;
		this.#prefix = prefix;
		this.#base = base;
		this.#plugins = plugins;
		this.#host = host;
	}

	/** The set published now (after `start`). */
	get set(): ScriptSet {
		return this.#set!;
	}

	/**
	 * Takes the kind's current set as the first one (its plugins' facets of the kind built on first use), before the
	 * server's load (the scripts object starts with it). The plugins whose build failed.
	 */
	async start(context: Context): Promise<readonly PluginFailure[]> {
		return this.#publish(await this.#plugins.scripts(this.#kind, context));
	}

	/** A published file by its path, from the last few sets. */
	file(path: string): ServedFile | undefined {
		for (let index = this.#sets.length - 1; index >= 0; index--) {
			const found = this.#sets[index]!.get(path);
			if (found !== undefined) return found;
		}
		return undefined;
	}

	/**
	 * The rollout step publishing the kind's current set as the rollout applied its build: one "host" named `name`, its
	 * report the plugins whose new build failed (they keep their last script, and stay dirty). Clients are not waited for.
	 */
	step(name: string): RolloutStep {
		return {
			name,
			kinds: [this.#kind],
			reload: async (_built: Built, context: Context) => {
				const before = new Map([...this.#current].map(([plugin, { digest }]) => [plugin, digest]));
				const failed = this.#publish(this.#plugins.current(this.#kind) ?? []);
				await publishTo(this.#host, this.#surface, this.set, context);
				const after = [...this.#current];
				const plugins = {
					added: after.filter(([plugin]) => !before.has(plugin)).map(([plugin]) => plugin),
					changed: after
						.filter(([plugin, { digest }]) => before.has(plugin) && before.get(plugin) !== digest)
						.map(([plugin]) => plugin),
					removed: [...before.keys()].filter((plugin) => !this.#current.has(plugin)),
				};
				return { hosts: [{ host: name, report: { plugins, failed, objects: [] } }] };
			},
		};
	}

	/**
	 * Takes `scripts` (the kind's complete set) as the current one: a failed build keeps its plugin's last script; its
	 * files kept with the last few sets'. The plugins whose build failed.
	 */
	#publish(scripts: readonly PluginScript[]): readonly PluginFailure[] {
		const failed: PluginFailure[] = [];
		const next = new Map<string, Published>();
		for (const { plugin, built } of scripts) {
			if (built.kind === "script") {
				const text = registeredSource(plugin.name, built.digest, built.source);
				next.set(plugin.name, { digest: built.digest, text, css: built.css?.text, assets: built.assets });
				continue;
			}
			failed.push({ plugin: plugin.name, error: new Error(built.errors.join("\n")) });
			const kept = this.#current.get(plugin.name);
			if (kept !== undefined) next.set(plugin.name, kept);
		}
		this.#current.clear();
		for (const [name, each] of [...next].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			this.#current.set(name, each);
		const { set, files } = this.#files();
		this.#sets.push(files);
		if (this.#sets.length > KEPT_SETS) this.#sets.shift();
		this.#set = set;
		return failed;
	}

	/**
	 * The set of the current scripts and its files: each script (its source map inline), stylesheet and asset, and the
	 * combined file (without source maps: a browser reads only one per file, so they would be bytes for nothing).
	 */
	#files(): { set: ScriptSet; files: Map<string, ServedFile> } {
		const files = new Map<string, ServedFile>();
		const entries: ScriptSet["plugins"][number][] = [];
		const combined: string[] = [];
		for (const [name, { digest, text, css, assets }] of this.#current) {
			// A plugin name (`@scope/name`) as one path segment, its slash a tilde: the set's URLs are looked up as they
			// are, never parsed back.
			const stem = `${this.#prefix}plugin/${name.replace("/", "~")}.${digest}`;
			files.set(`${stem}.js`, { mime: JAVASCRIPT, bytes: new TextEncoder().encode(text) });
			if (css !== undefined) files.set(`${stem}.css`, { mime: CSS, bytes: new TextEncoder().encode(css) });
			entries.push({ name, digest, url: `${stem}.js`, ...(css === undefined ? {} : { css: `${stem}.css` }) });
			combined.push(text.replace(SOURCE_MAP, ""));
			for (const asset of assets) {
				files.set(`${this.#prefix}assets/${asset.name}`, { mime: mimeOf(asset.name), bytes: asset.bytes });
			}
		}
		const body = combined.join("");
		const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
		const url = `${this.#prefix}plugins.${hash}.js`;
		files.set(url, { mime: JAVASCRIPT, bytes: new TextEncoder().encode(body) });
		return { set: { base: this.#base, combined: url, plugins: entries }, files };
	}
}
