// The view kit (docs/rooms.md): loaded into every custom view's frame after the bridge, it adds rooms and methods to
// `window.p2view`. Nothing connects until the page's code asks for its room or offers methods.
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import type { Base, Peer, Presence, RoomKind } from "../room-contract.ts";
import { loadText, type TextEdit } from "../text.ts";
import { Connection, type Connection as ConnectionType, type Delivered, type Offered } from "./connection.ts";
import { type Cursor, TextClient } from "./text-client.ts";

type Listeners<T extends unknown[]> = Set<(...args: T) => void>;

/** Calls every listener; one that throws is logged (the view's errors show it) and the others still run. */
function emit<T extends unknown[]>(listeners: Listeners<T>, ...args: T): void {
	for (const listener of [...listeners])
		try {
			listener(...args);
		} catch (error) {
			console.error(error);
		}
}

/** Adds `fn` to `listeners`; returns its removal. */
function listen<T extends unknown[]>(listeners: Listeners<T>, fn: (...args: T) => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

const query = new URL(location.href).searchParams;
let connection: ConnectionType | undefined;
/** The frame's one connection, opened on first use. */
const connect = (): ConnectionType => {
	connection ??= new Connection(query.get("session") ?? "", query.get("view") ?? "");
	return connection;
};
const rooms = new Map<RoomKind, unknown>();

/** A live or log room as the page's code uses it. */
function createRoom(kind: "live" | "log") {
	const link = connect();
	const peers: Listeners<[readonly Peer[], string | null]> = new Set();
	const messages: Listeners<[Delivered]> = new Set();
	const resets: Listeners<[unknown, number]> = new Set();
	let presence: Presence = { peers: [], leader: null };
	let base: Base | undefined;
	const joined = link.join(kind, {
		presence: (next) => {
			presence = next;
			emit(peers, next.peers, next.leader);
		},
		reset: (next) => {
			base = next;
			emit(resets, next.value, next.seq);
		},
		deliver: (list) => {
			for (const message of list) emit(messages, message);
		},
	});
	joined.catch((error: unknown) => console.error(error));
	return {
		kind,
		/** Resolves once this frame joined. */
		ready: joined,
		get me() {
			return link.me;
		},
		get peers() {
			return presence.peers;
		},
		get leader() {
			return presence.leader;
		},
		get isLeader() {
			return link.me !== "" && presence.leader === link.me;
		},
		/** The state a log room started from (its base), undefined before it joined. */
		get state() {
			return base?.value;
		},
		onPeers: (fn: (peers: readonly Peer[], leader: string | null) => void) => {
			if (link.me) fn(presence.peers, presence.leader);
			return listen(peers, fn);
		},
		onMessage: (fn: (message: Delivered) => void) => listen(messages, fn),
		onReset: (fn: (state: unknown, seq: number) => void) => {
			if (base) fn(base.value, base.seq);
			return listen(resets, fn);
		},
		send: (data: unknown, options?: { key?: string }) => link.send(data, options?.key),
		now: () => link.now(),
		/** Log rooms, the leader: `state` is the room's state after every message applied so far. */
		snapshot: (state: unknown) =>
			link.call(async (ref) => {
				const room = ref.room.value;
				if (!room.base) throw new Error("This room has no base");
				await ref.snapshot(
					{
						seq: link.applied,
						epoch: room.base.epoch,
						term: room.term,
						value: JSON.parse(JSON.stringify(state ?? null)),
					},
					BACKGROUND,
				);
			}),
	};
}

/** A text room: the shared text, edits through it, others' cursors. */
function createText() {
	const link = connect();
	const changes: Listeners<[string, "local" | "remote"]> = new Set();
	const cursorListeners: Listeners<[readonly { peer: string; name: string; anchor: number; head: number }[]]> =
		new Set();
	let client: TextClient | undefined;
	let presence: Presence = { peers: [], leader: null };
	const cursors = new Map<string, { anchor: Cursor; head: Cursor }>();
	let sending = false;
	let sent = 0;
	let bound: HTMLTextAreaElement | HTMLInputElement | undefined;
	let composing = false;

	const shownCursors = () => {
		const out: { peer: string; name: string; anchor: number; head: number }[] = [];
		for (const [peer, cursor] of cursors) {
			const anchor = client?.indexOf(cursor.anchor);
			const head = client?.indexOf(cursor.head);
			const name = presence.peers.find((each) => each.id === peer)?.name;
			if (anchor !== undefined && head !== undefined && name !== undefined && peer !== link.me)
				out.push({ peer, name, anchor, head });
		}
		return out;
	};
	const changed = (from: "local" | "remote") => {
		const value = client?.doc.text ?? "";
		if (bound && !composing && bound.value !== value) {
			const start = client?.indexOf(selection.anchor) ?? 0;
			const end = client?.indexOf(selection.head) ?? start;
			bound.value = value;
			bound.setSelectionRange(Math.min(start, end), Math.max(start, end));
		}
		emit(changes, value, from);
		emit(cursorListeners, shownCursors());
	};
	let selection: { anchor: Cursor; head: Cursor } = { anchor: null, head: null };
	/** Sends pending batches in order, one call at a time (again from the first after a reconnect). */
	const flush = async () => {
		if (sending || !client) return;
		sending = true;
		try {
			for (;;) {
				const batch = client.pending.find((each) => each.n > sent);
				if (!batch) break;
				sent = batch.n;
				await link.call((ref) => ref.edit({ n: batch.n, edits: [...batch.edits] }, BACKGROUND));
			}
		} catch (error) {
			console.error(error);
		} finally {
			sending = false;
		}
	};

	const joined = link.join("text", {
		presence: (next) => {
			presence = next;
			// A frame whose viewer may only watch cannot type (the room would refuse its edits).
			if (bound && link.me)
				bound.readOnly = !next.peers.some((each) => each.id === link.me && each.mode === "write");
			for (const peer of cursors.keys()) if (!next.peers.some((each) => each.id === peer)) cursors.delete(peer);
			emit(cursorListeners, shownCursors());
		},
		reset: (base) => {
			const loaded = loadText(base.value);
			if (!loaded) return;
			const mark = loaded.marks[link.editor] ?? 0;
			if (client) client.reset(loaded.doc, mark);
			else client = new TextClient(link.editor, loaded.doc, mark);
			changed("remote");
		},
		deliver: (list) => {
			let remote = false;
			for (const message of list) {
				if (message.n !== undefined) {
					client?.confirm(message.from, message.n, message.data as TextEdit[]);
					remote ||= message.from !== link.editor;
				} else if (message.key === "cursor") {
					const data = message.data as { anchor?: Cursor; head?: Cursor } | null;
					cursors.set(message.from, { anchor: data?.anchor ?? null, head: data?.head ?? null });
				}
			}
			changed(remote ? "remote" : "local");
		},
		reconnected: () => {
			sent = 0;
			void flush();
		},
	});
	joined.catch((error: unknown) => console.error(error));

	/** The person's change of the whole text to `next`. */
	const set = (next: string) => {
		if (!client) return;
		if (client.input(String(next))) {
			changed("local");
			void flush();
		}
	};
	const setCursor = (anchor: number, head = anchor) => {
		if (!client) return;
		selection = { anchor: client.cursorAt(anchor), head: client.cursorAt(head) };
		link.send(selection, "cursor");
	};
	return {
		kind: "text" as const,
		ready: joined,
		get me() {
			return link.me;
		},
		get peers() {
			return presence.peers;
		},
		get value() {
			return client?.doc.text ?? "";
		},
		now: () => link.now(),
		set,
		setCursor,
		onChange: (fn: (value: string, from: "local" | "remote") => void) => {
			if (client) fn(client.doc.text, "remote");
			return listen(changes, fn);
		},
		onCursors: (fn: (cursors: readonly { peer: string; name: string; anchor: number; head: number }[]) => void) =>
			listen(cursorListeners, fn),
		/** Keeps `element` (a textarea or input) and the shared text in step, and sends its caret as the cursor. */
		bind(element: HTMLTextAreaElement | HTMLInputElement) {
			bound = element;
			element.value = client?.doc.text ?? "";
			const input = () => {
				if (!composing) set(element.value);
			};
			const caret = () => {
				if (document.activeElement === element) setCursor(element.selectionStart ?? 0, element.selectionEnd ?? 0);
			};
			element.addEventListener("input", input);
			element.addEventListener("compositionstart", () => {
				composing = true;
			});
			element.addEventListener("compositionend", () => {
				composing = false;
				set(element.value);
			});
			document.addEventListener("selectionchange", caret);
			return () => {
				bound = undefined;
				element.removeEventListener("input", input);
				document.removeEventListener("selectionchange", caret);
			};
		},
	};
}

declare global {
	interface Window {
		/** The bridge's API (`bridge.ts`), which this kit extends. */
		p2view: Record<string, unknown>;
	}
}

const p2view = window.p2view;
/** The view's room of `kind` (one per frame and kind; the first call opens the frame's link). */
p2view.room = (kind: RoomKind) => {
	if (kind !== "live" && kind !== "log" && kind !== "text") throw new Error(`No room kind ${String(kind)}`);
	let room = rooms.get(kind);
	if (!room) {
		room = kind === "text" ? createText() : createRoom(kind);
		rooms.set(kind, room);
	}
	return room;
};
/** Methods the agent may call (`view_call`): `{ name: { description, args, run, idempotent? } }`. */
p2view.methods = {
	offer: (methods: Readonly<Record<string, Offered>>) =>
		connect()
			.offer(methods)
			.catch((error: unknown) => console.error(error)),
};
