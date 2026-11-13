// Live folder listings (Files v2): what a `FilesFolder` object shows, the first entries of one folder, followed
// (`self.follow`) from the host's `Files`. Files reads a watched folder again after each change of its space, inside
// the method that changed it, and hands the listing to its watchers; a listing attaching meanwhile reads again. One
// read per watched folder and change: meant for the folders on someone's screen, not for every folder of a drive.

import type { Context } from "../../context/index.ts";
import type { FollowAttachment, FollowObserver } from "../../host/index.ts";
import type { FolderEntry } from "./files-index.ts";

/** A folder's first entries, and whether more follow. */
export type FolderListing = { readonly entries: FolderEntry[]; readonly more: boolean };

/** How a folder's listing is read: the current `Files` attempt's index. */
export type ListingReader = (space: string, folder: string, context: Context) => Promise<FolderListing>;

/** A watched folder: its observer, and whether it is still attaching (then a change makes it read again). */
type View = {
	readonly space: string;
	readonly folder: string;
	readonly observer: FollowObserver<unknown>;
	attaching: boolean;
	stale: boolean;
};

/** The watched folders of one host's `Files`. */
export class FolderViews {
	#reader: ListingReader | undefined;
	readonly #views = new Set<View>();

	/** Reads through `reader` from now on (each `Files` attempt binds its own). */
	bind(reader: ListingReader): void {
		this.#reader = reader;
	}

	/** Watches folder `folder` of `space` for `observer`: its listing now, and its detach. */
	async attach(
		space: string,
		folder: string,
		observer: FollowObserver<unknown>,
		context: Context,
	): Promise<FollowAttachment<FolderListing>> {
		const view: View = { space, folder, observer, attaching: true, stale: false };
		this.#views.add(view);
		try {
			let value: FolderListing;
			do {
				view.stale = false;
				value = await this.#read(space, folder, context);
			} while (view.stale);
			view.attaching = false;
			return { value, detach: () => this.#views.delete(view) };
		} catch (error) {
			this.#views.delete(view);
			throw error;
		}
	}

	/** Space `space` changed: every watched folder of it is read again (once per folder) and its watchers told. */
	async changed(space: string, context: Context): Promise<void> {
		const byFolder = new Map<string, View[]>();
		for (const view of this.#views) {
			if (view.space !== space) continue;
			if (view.attaching) view.stale = true;
			else byFolder.set(view.folder, [...(byFolder.get(view.folder) ?? []), view]);
		}
		for (const [folder, views] of byFolder) {
			const value = await this.#read(space, folder, context);
			for (const view of views) {
				if (this.#views.has(view))
					view.observer.advance({ kind: "value", value, ops: [["r", value]], retired: false }, context);
			}
		}
	}

	/** The listing through the bound reader (bound before any `FilesFolder` goes live: it waits for `Files`). */
	#read(space: string, folder: string, context: Context): Promise<FolderListing> {
		return this.#reader!(space, folder, context);
	}
}
