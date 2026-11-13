/**
 * Conversations kept on the device (IndexedDB), so opening one shows it at once, before the connection is back: a
 * cold start (iOS discards a home-screen app in the background), a reload after an update. What was kept seeds the
 * conversation's transcript (`TranscriptStore.seed`); the live view is merged into it when it continues it, and
 * replaces it otherwise.
 *
 * Only the owner's browser keeps conversations: a guest's share can end, and what it saw must not stay on its device.
 * Signing out, or the server saying this browser is no longer the owner, clears everything kept (`clearKept`).
 *
 * Per conversation: the transcript's newest entries without a gap among them, up to `MAX_BYTES` (older ones page in
 * again from the server), with the documents but without the live state (a run, its queue: stale once kept), and the
 * measured row heights. The most recently used `MAX_CONVERSATIONS` stay.
 */
import type { ConversationView, TranscriptView } from "@earendil-works/pi-durable";
import { keptWindow } from "./history.ts";

export type Kept = {
	readonly key: string;
	readonly savedAt: number;
	/** The kept entries as a window: `before` is the entry just before them, absent when they start the conversation. */
	readonly view: ConversationView;
	/** Measured row heights by row key. */
	readonly sizes: readonly (readonly [string, number])[];
};

/** What `keep` reads at write time. */
export type Keeping = { readonly view: TranscriptView; readonly sizes: readonly (readonly [string, number])[] };

const DATABASE = "p2-conversations";
const STORE = "kept";
const MAX_CONVERSATIONS = 20;
/** Serialized size above which the oldest retained entries are dropped (images make entries large). */
const MAX_BYTES = 4_000_000;
const SAVE_AFTER = 1_000;

let opened: Promise<IDBDatabase | undefined> | undefined;

/** The database, or undefined where IndexedDB does not work (private modes, old browsers): nothing is kept then. */
function database(): Promise<IDBDatabase | undefined> {
	opened ??= new Promise((resolve) => {
		try {
			// Version 2 keeps a window instead of a view and its history pages: what version 1 kept is dropped.
			const request = indexedDB.open(DATABASE, 2);
			request.onupgradeneeded = () => {
				if (request.result.objectStoreNames.contains(STORE)) request.result.deleteObjectStore(STORE);
				request.result.createObjectStore(STORE, { keyPath: "key" });
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => resolve(undefined);
			request.onblocked = () => resolve(undefined);
		} catch {
			resolve(undefined);
		}
	});
	return opened;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** What was kept of conversation `key` (`session#conversation`), if anything. */
export async function loadKept(key: string): Promise<Kept | undefined> {
	const db = await database();
	if (!db) return undefined;
	try {
		return (await done(db.transaction(STORE).objectStore(STORE).get(key))) as Kept | undefined;
	} catch {
		return undefined;
	}
}

/** The transcript as kept: its newest entries, without a run's live state or the queue, stale once the page is gone. */
function keptView(view: TranscriptView): ConversationView {
	const kept = keptWindow(view, MAX_BYTES);
	const docs = { ...kept.docs };
	delete docs["pi.live"];
	delete docs["pi.inbox"];
	return { ...kept, docs };
}

const pending = new Map<string, () => Keeping>();
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * Keeps conversation `key` as `read()` gives it, a second after the last call (a streaming answer calls often), or
 * when the page is hidden. `read` is called at write time, with the newest state.
 */
export function keep(key: string, read: () => Keeping): void {
	pending.set(key, read);
	clearTimeout(timer);
	timer = setTimeout(() => void flush(), SAVE_AFTER);
}

/** Writes what `keep` collected now. */
export async function flush(): Promise<void> {
	clearTimeout(timer);
	if (pending.size === 0) return;
	const writes = [...pending].map(([key, read]) => {
		const { view, sizes } = read();
		// Through JSON: views and entries are plain data, and reactive containers must not reach IndexedDB.
		return JSON.parse(JSON.stringify({ key, savedAt: Date.now(), view: keptView(view), sizes })) as Kept;
	});
	pending.clear();
	const db = await database();
	if (!db) return;
	try {
		const transaction = db.transaction(STORE, "readwrite");
		const store = transaction.objectStore(STORE);
		for (const value of writes) store.put(value);
		// The most recently used conversations stay.
		const all = (await done(store.getAll())) as Kept[];
		for (const old of all.sort((a, b) => b.savedAt - a.savedAt).slice(MAX_CONVERSATIONS)) store.delete(old.key);
		await new Promise<void>((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
	} catch {
		// Full storage or a closed database: the conversation is simply not kept.
	}
}

/** Forgets the kept conversations of session `id` (the server no longer has it). */
export async function forgetSession(id: string): Promise<void> {
	for (const key of pending.keys()) if (key.startsWith(`${id}#`)) pending.delete(key);
	const db = await database();
	if (!db) return;
	try {
		const store = db.transaction(STORE, "readwrite").objectStore(STORE);
		const keys = (await done(store.getAllKeys())) as string[];
		for (const key of keys) if (key.startsWith(`${id}#`)) store.delete(key);
	} catch {}
}

/** Forgets kept conversations of sessions not in `sessions` (the server's list, archived ones included). */
export async function keepSessions(sessions: ReadonlySet<string>): Promise<void> {
	const db = await database();
	if (!db) return;
	try {
		const store = db.transaction(STORE, "readwrite").objectStore(STORE);
		const keys = (await done(store.getAllKeys())) as string[];
		for (const key of keys) if (!sessions.has(key.slice(0, key.lastIndexOf("#")))) store.delete(key);
	} catch {}
}

/** Forgets every kept conversation (signing out; this browser is no longer the owner). */
export async function clearKept(): Promise<void> {
	pending.clear();
	clearTimeout(timer);
	const db = await database();
	if (!db) return;
	try {
		await done(db.transaction(STORE, "readwrite").objectStore(STORE).clear());
	} catch {}
}

// Hidden pages may be discarded without another chance to write (iOS home-screen apps above all).
if (typeof document !== "undefined") {
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") void flush();
	});
	addEventListener("pagehide", () => void flush());
}
