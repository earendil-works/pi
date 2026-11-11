// The owner's library of saved views (server): one JSON file per view in `<data>/views/`, read once at start and
// written through this store, which tells listeners of each change.
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compile } from "@earendil-works/pi-schema";
import { MAX_VIEW_HTML, MAX_VIEW_STATE, type SavedInfo, type SavedView, SavedViewSchema, VIEW_ID } from "./contract.ts";

const isSavedView = compile(SavedViewSchema).check;

/** A saved view's file, at most this large: its HTML and state with room for the rest. */
const MAX_FILE = MAX_VIEW_HTML + MAX_VIEW_STATE + 64 * 1024;

/** The saved views of one data directory. */
export class Library {
	readonly #dir: string;
	readonly #listeners = new Set<() => void>();
	#saved: SavedInfo[] = [];

	constructor(dataDir: string) {
		this.#dir = join(dataDir, "views");
	}

	/** Every saved view, newest first. */
	get saved(): SavedInfo[] {
		return this.#saved;
	}

	/** Reads the directory; files that are not saved views are skipped. */
	async load(): Promise<void> {
		const names = await readdir(this.#dir).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		const saved: SavedInfo[] = [];
		for (const file of names) {
			if (!file.endsWith(".json")) continue;
			const view = await this.get(file.slice(0, -".json".length));
			if (view) saved.push(infoOf(view));
		}
		this.#saved = saved.sort((a, b) => b.saved - a.saved);
	}

	/** Calls `listener` after each change; returns the stop. */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Saved view `name`, or null (a missing or unreadable file). */
	async get(name: string): Promise<SavedView | null> {
		if (!VIEW_ID.test(name)) return null;
		try {
			// The files are the owner's to edit: read them as untrusted.
			const text = await readFile(join(this.#dir, `${name}.json`), "utf8");
			if (text.length > MAX_FILE) return null;
			const value: unknown = JSON.parse(text);
			return isSavedView(value) && value.name === name ? value : null;
		} catch {
			return null;
		}
	}

	/** Saves `view` under its name, replacing a view saved under it before. */
	async save(view: SavedView): Promise<SavedInfo> {
		const text = JSON.stringify(view, null, "\t");
		if (text.length > MAX_FILE) throw new Error("The view is too large to save");
		await mkdir(this.#dir, { recursive: true });
		const path = join(this.#dir, `${view.name}.json`);
		await writeFile(`${path}.tmp`, text, "utf8");
		await rename(`${path}.tmp`, path);
		const info = infoOf(view);
		this.#saved = [info, ...this.#saved.filter((each) => each.name !== view.name)];
		this.#changed();
		return info;
	}

	/** Removes saved view `name` (an unknown one: nothing). */
	async remove(name: string): Promise<void> {
		if (!VIEW_ID.test(name)) return;
		await rm(join(this.#dir, `${name}.json`), { force: true });
		this.#saved = this.#saved.filter((each) => each.name !== name);
		this.#changed();
	}

	#changed(): void {
		for (const listener of this.#listeners) listener();
	}
}

/** A saved view's entry in lists. */
function infoOf(view: SavedView): SavedInfo {
	return {
		name: view.name,
		title: view.title,
		kind: view.kind,
		saved: view.saved,
		...(view.description ? { description: view.description } : {}),
	};
}
