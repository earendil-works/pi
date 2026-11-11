// One room's store (server, docs/rooms.md §3): what every `ViewRoom` of one opening of a custom view shares. Its
// in-memory documents are the room's facts, the window, the keyed messages (all three state members), the journal in
// blocks, the offers and the room's accounting (not exposed). It numbers and publishes messages, trims them, keeps a
// log room's snapshots and a text room's text (applied here, written to the worker), and runs the agent's calls
// through the leader's frame.
import { randomBytes, randomUUID } from "node:crypto";
import { arr, bool, int, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import {
	type Ctx,
	defineTypedKeyedState,
	defineTypedState,
	type FacetHost,
	forbidden,
	invalid,
	type JsonValue,
	local,
	method,
	PluginError,
	param,
	record,
	sleep,
	type Tx,
	unsafe,
	viewKey,
	withCancel,
	withoutAbortSignal,
} from "@p2/app/v1";
import { MAX_CLIENT_FRAME, Server } from "@p2/app/v1/server";
import { ElementIdGenerator } from "articulated";
import { ModelConfig } from "../models/contract.ts";
import {
	AnswerSchema,
	type BackedState,
	type Call,
	CallArgsSchema,
	EditBatchSchema,
	HistoryArgsSchema,
	HistorySchema,
	KeyedByPeerSchema,
	LogSchema,
	type Message,
	MessageSchema,
	MethodInfoSchema,
	OutgoingSchema,
	type Presence,
	PresenceSchema,
	RoomKindSchema,
	RoomSchema,
	SnapshotSchema,
	tagged,
	ViewBacking,
	ViewOpenings,
	ViewRoom,
} from "./room-contract.ts";
import { applyEdits, editsTo, freshText, loadText, MAX_TEXT, saveText, type TextDoc, type TextEdit } from "./text.ts";

/** One room's store (server-internal): every `ViewRoom` of one opening of a view shares it. */
export const RoomStore = local("p2.view-room-store", {
	version: 1,
	params: { session: param.str(), view: param.str(), opening: param.str() },
	members: {
		room: RoomSchema,
		presence: PresenceSchema,
		log: LogSchema,
		keyed: KeyedByPeerSchema,
		/** `writer`: the frame may write; only a writer changes the room's kind (a reset). */
		join: method(obj({ peer: str(), writer: bool(), kind: opt(RoomKindSchema) }), obj({ from: int() })),
		send: method(obj({ peer: str(), messages: OutgoingSchema, ack: opt(int()) })),
		ack: method(obj({ peer: str(), seq: int() })),
		history: method(HistoryArgsSchema, HistorySchema),
		offer: method(obj({ peer: str(), methods: arr(MethodInfoSchema, { maxItems: 100 }) })),
		answer: method(obj({ peer: str(), answer: AnswerSchema })),
		snapshot: method(obj({ peer: str(), snapshot: SnapshotSchema })),
		edit: method(obj({ editor: str(), batch: EditBatchSchema })),
		methods: method(undefined, arr(MethodInfoSchema)),
		call: method(CallArgsSchema, unsafe<JsonValue>(unknown())),
	},
});

/** What all rooms of the server keep, in bytes (settings.json `viewRoomsMemory`). */
export type RoomMemory = { used: number };

/** What the rooms' facet gives each store. */
export type RoomStoreParts = {
	readonly memory: RoomMemory;
	/** Drops the unused tokens of one opening of a view. */
	readonly dropTokens: (session: string, view: string, opening: string) => void;
};

/** The window every peer holds: at most this many journal messages… */
const WINDOW_MESSAGES = 256;
/** …and this much of their data (UTF-16 bytes). */
const WINDOW_BYTES = 512 * 1024;
/** Journal messages per block (one keyed document): an append drafts one block, never the whole journal. */
const BLOCK = 256;
/**
 * What one retained entry costs beyond its strings, in bytes: measured on Node 24 for a journal message (its object in
 * the journal and in the window, three fields each), 117 bytes; charged for keyed entries and editors' marks too.
 */
const ENTRY_COST = 128;
/**
 * The keyed member's encoding beyond its keys and data, measured from `JSON.stringify` of the member: an entry's
 * colon, braces, field names, number (up to 16 digits) and comma (`:{"seq":…,"data":},` 33 bytes); a peer's colon,
 * braces and comma (4); the root (`{"peers":{}}`, 12).
 */
const KEYED_ENCODING = 33;
const KEYED_PEER = 4;
const KEYED_ROOT = 12;
/** A text room makes a new base after this many journal messages. */
const TEXT_BASE_EVERY = 200;
/** How long a text room waits after an edit before it writes the text. */
const TEXT_WRITE_PAUSE = 500;
/** How long the agent's call waits for the leader's answer. */
const CALL_TIMEOUT = 60_000;
/** Chord's heartbeat close timeout: a live room's peer behind everyone else longer than this is disconnected. */
const LAG_LIMIT = 30_000;
/** The editor of the text the room takes from outside (the agent, a page's state). */
const SERVER_EDITOR = "server";
/** The default of settings.json's `viewRoomsMemory`, in MiB. */
const DEFAULT_MEMORY_MIB = 64;

const RoomDoc = defineTypedState("p2.view-room.room", {
	schema: RoomSchema,
	version: 1,
	// Each new store (not a reload's restart: its documents stay) is an incarnation of its own.
	initial: () => ({ store: randomUUID(), kind: null, seq: 0, term: 0, base: null, calls: [] }),
});
const LogDoc = defineTypedState("p2.view-room.log", {
	schema: LogSchema,
	version: 1,
	initial: () => ({ start: 0, messages: [] }),
});
const KeyedDoc = defineTypedState("p2.view-room.keyed", {
	schema: KeyedByPeerSchema,
	version: 1,
	initial: () => ({ peers: {} }),
});
/** The journal's messages numbered in [key × BLOCK, (key + 1) × BLOCK), by block. */
const BlockDoc = defineTypedKeyedState("p2.view-room.block", {
	schema: obj({ messages: arr(MessageSchema) }),
	version: 1,
	initial: () => ({ messages: [] }),
});
/**
 * The room's accounting: the journal holds the messages after `from`; `bytes` is what the room keeps, `keyed` the
 * keyed member's encoded size; a text room's text changed at message `textSeq` and was written as of `savedSeq`;
 * `seen` is the view state's revision the room took last (its own writes included; -1: none), kept here so that a
 * reload's new attempt takes a change made meanwhile.
 */
const InfoDoc = defineTypedState("p2.view-room.info", {
	schema: obj({ from: int(), bytes: int(), keyed: int(), textSeq: int(), savedSeq: int(), seen: int() }),
	version: 1,
	initial: () => ({ from: 0, bytes: 0, keyed: 0, textSeq: 0, savedSeq: 0, seen: -1 }),
});
/** Each peer's offered methods, numbered per peer (not a state member: only the agent reads them). */
const OffersDoc = defineTypedState("p2.view-room.offers", {
	schema: obj({ peers: record(obj({ n: int(), methods: arr(MethodInfoSchema) })) }),
	version: 1,
	initial: () => ({ peers: {} }),
});

/** A journal message's block key. */
const blockOf = (seq: number): string => String(Math.floor(seq / BLOCK));

/** Serves `RoomStore`. */
export function serveRoomStore(host: FacetHost, { memory, dropTokens }: RoomStoreParts): void {
	const references = host.references(ViewRoom);
	host.serve(
		RoomStore,
		({ session, view, opening }, self) => {
			const server = self.get(Server, {});
			const models = self.get(ModelConfig, {});
			const openings = self.get(ViewOpenings, { session });
			const backing = self.get(ViewBacking, { session, view, opening });
			const room = self.state(RoomDoc);
			const log = self.state(LogDoc);
			const keyed = self.state(KeyedDoc);
			const blocks = self.state(BlockDoc);
			const info = self.state(InfoDoc);
			const offers = self.state(OffersDoc);
			const presence = self.derive([references], ([list]): Presence => {
				const peers: Presence["peers"] = [];
				const seen = new Set<string>();
				for (const { principal } of list) {
					// One frame may hold its room more than once (a reconnect, a re-render): one peer per link.
					if (principal?.kind !== "view") continue;
					if (principal.session !== session || principal.view !== view || principal.opening !== opening) continue;
					if (seen.has(principal.link)) continue;
					seen.add(principal.link);
					peers.push({
						id: principal.link,
						name: principal.for.name,
						role: principal.for.role,
						mode: principal.mode,
					});
				}
				return { peers, leader: peers.find((each) => each.mode === "write")?.id ?? null };
			});
			const unsaved = self.derive([info], ([value]) => value.textSeq > value.savedSeq);

			// What this attempt keeps outside documents (a reload's restart starts them over).
			const acks = new Map<string, { seq: number; behind?: number }>();
			const waiting = new Map<
				string,
				{ peer: string; offer: number; idempotent: boolean; settle: (outcome: Outcome) => void }
			>();
			let text: { doc: TextDoc; marks: Record<string, number> } | undefined;
			let bunches = 0;
			const bunch = `s${randomBytes(6).toString("base64url")}`;
			const ids = new ElementIdGenerator(() => `${bunch}.${(bunches++).toString(36)}`);
			/** The view state's revision this room took last (`InfoDoc.seen`). */
			const seenRevision = () => info.value.seen;
			const markSeen = (revision: number, ctx: Ctx) =>
				info.change((draft) => {
					draft.seen = revision;
				}, ctx);
			let writing: Promise<unknown> = Promise.resolve();
			/**
			 * Runs `fn` after every change of the room's state or text started before it (one at a time): writes and the
			 * changes they race with are applied in order. Its caller gets its outcome; the chain only waits for it.
			 */
			const serial = <T>(fn: () => Promise<T>): Promise<T> => {
				const run = writing.then(fn);
				writing = run.then(
					() => undefined,
					() => undefined,
				);
				return run;
			};
			let lastLeader: string | null = null;
			// This room's share of the budget: counted when it opens, given back when it ends.
			self.open(
				async () => {
					memory.used += info.value.bytes;
				},
				() => {
					memory.used -= info.value.bytes;
				},
			);
			const budget = (): number =>
				(models.snapshot.value.settings.viewRoomsMemory ?? DEFAULT_MEMORY_MIB) * 1024 * 1024;

			/**
			 * Charges `bytes` to the room inside a transaction, before anything it pays for is kept: refused past the
			 * budget. Checked and counted in one step, so a concurrent charge (another room's) sees it; `charged` takes it
			 * back when the transaction fails.
			 */
			const charge = (draft: { bytes: number }, bytes: number, ledger: { bytes: number }, reserved = 0) => {
				if (bytes > 0 && memory.used - reserved + bytes > budget()) throw roomFull();
				draft.bytes += bytes;
				ledger.bytes += bytes;
				memory.used += bytes;
			};
			/** Runs `fn` as one transaction of this store; its charges are taken back when it fails. */
			const charged = async <T>(fn: (tx: Tx, ledger: { bytes: number }) => Promise<T>, ctx: Ctx): Promise<T> => {
				const ledger = { bytes: 0 };
				try {
					return await self.tx((tx) => fn(tx, ledger), ctx);
				} catch (error) {
					memory.used -= ledger.bytes;
					throw error;
				}
			};
			const peerIds = () => new Set(presence.value.peers.map((each) => each.id));

			/**
			 * Numbers `items` of `from` and publishes them in one transaction (numbers, journal and window agree whatever
			 * else runs): keyed ones set their entry's leaves, unkeyed ones go to the journal and the window, which is
			 * trimmed to its bounds. Charged before anything is kept; a keyed member past the link part limit is refused.
			 */
			const publish = (
				from: string,
				items: readonly { readonly key?: string; readonly data: string; readonly n?: number }[],
				ctx: Ctx,
			) =>
				charged(async (tx, ledger) => {
					const numbers = await tx.draft(room);
					const account = await tx.draft(info);
					const window = await tx.draft(log);
					const byKey = items.some((item) => item.key !== undefined) ? await tx.draft(keyed) : undefined;
					let keyedSize = account.keyed;
					for (const { key, data, n } of items) {
						const seq = ++numbers.seq;
						if (key === undefined || byKey === undefined) {
							charge(account, 2 * (data.length + from.length) + ENTRY_COST, ledger);
							const message: Message = { seq, from, data, ...(n === undefined ? {} : { n }) };
							(await tx.draft(blocks, blockOf(seq))).messages.push(message);
							window.messages.push(message);
							if (n !== undefined) account.textSeq = seq;
							continue;
						}
						byKey.peers[from] ??= {};
						const entries = byKey.peers[from];
						const entry = entries[key];
						const value = tagged(data, entry?.data);
						// A peer's first key adds its own entry (its ID) to the member.
						const first = !entry && Object.keys(entries).length === 0;
						keyedSize +=
							encodedEntry(key, value) -
							(entry ? encodedEntry(key, entry.data) : 0) +
							(first ? encodedPeer(from) : 0);
						if (KEYED_ROOT + keyedSize > MAX_CLIENT_FRAME)
							throw new PluginError(
								"too_large",
								"The room's keyed messages would not fit one snapshot for a joining frame (the link's part limit)",
							);
						charge(
							account,
							keptEntry(key, value) - (entry ? keptEntry(key, entry.data) : 0) + (entry ? 0 : ENTRY_COST),
							ledger,
						);
						// The entry stays and only its two primitive leaves change: a slow peer's pending sets fold.
						if (entry) {
							entry.seq = seq;
							entry.data = value;
						} else entries[key] = { seq, data: value };
					}
					account.keyed = keyedSize;
					let bytes = 0;
					for (const message of window.messages) bytes += 2 * message.data.length;
					let drop = 0;
					while (
						window.messages.length - drop > 1 &&
						(window.messages.length - drop > WINDOW_MESSAGES || bytes > WINDOW_BYTES)
					)
						bytes -= 2 * (window.messages[drop++]?.data.length ?? 0);
					if (drop) {
						window.start = window.messages[drop - 1]?.seq ?? window.start;
						window.messages.splice(0, drop);
					}
				}, ctx);

			/**
			 * Drops journal messages up to `seq` (whole blocks retired, the last one cut) and from the window. What it
			 * drops and frees is read inside the transaction, on the store's line: concurrent trims never count a block
			 * twice, and the journal's start never moves back.
			 */
			const trimTo = async (seq: number, ctx: Ctx) => {
				if (seq <= info.value.from) return;
				await charged((tx, ledger) => trimIn(tx, ledger, seq), ctx);
			};
			/** `trimTo`'s step inside a transaction. */
			const trimIn = async (tx: Tx, ledger: { bytes: number }, seq: number) => {
				const account = await tx.draft(info);
				if (seq <= account.from) return;
				const last = Math.floor(seq / BLOCK);
				let freed = 0;
				for (let block = Math.floor((account.from + 1) / BLOCK); block <= last; block++) {
					const draft = await tx.draft(blocks, String(block));
					const cut =
						block < last ? draft.messages.length : draft.messages.findIndex((message) => message.seq > seq);
					const removed = draft.messages.splice(0, cut < 0 ? draft.messages.length : cut);
					for (const message of removed) freed += messageCost(message);
					if (block < last) await tx.retire(blocks, String(block));
				}
				charge(account, -freed, ledger);
				account.from = seq;
				const window = await tx.draft(log);
				const at = window.messages.findIndex((message) => message.seq > seq);
				window.messages.splice(0, at < 0 ? window.messages.length : at);
				if (window.start < seq) window.start = seq;
			};

			/** A live room drops what every present peer applied. */
			const trimLive = async (ctx: Ctx) => {
				if (room.value.kind !== "live") return;
				let low = room.value.seq;
				for (const id of peerIds()) low = Math.min(low, acks.get(id)?.seq ?? low);
				await trimTo(low, ctx);
			};

			/**
			 * Sets the base (log and text rooms; null: none) as of message `seq`, charged by its size, and drops the
			 * journal up to it.
			 */
			const setBase = async (
				base: { seq: number; epoch: number; value: JsonValue } | null,
				ctx: Ctx,
				reserved = 0,
			) => {
				const size = base ? 2 * JSON.stringify(base.value).length : 0;
				// One transaction: the journal up to the base goes with the base's arrival (a joiner never sees one
				// without the other), and what it frees pays for the base first.
				await charged(async (tx, ledger) => {
					if (base) await trimIn(tx, ledger, base.seq);
					const facts = await tx.draft(room);
					const old = facts.base ? 2 * JSON.stringify(facts.base.value).length : 0;
					charge(await tx.draft(info), size - old, ledger, reserved);
					facts.base = base;
				}, ctx);
			};
			/** A new base of `value` as of the room's newest message. */
			const rebase = (value: JsonValue, epoch: number, ctx: Ctx) =>
				setBase({ seq: room.value.seq, epoch, value }, ctx);

			/**
			 * The journal's messages after `after` (and up to `upTo`), block by block, at most `limit` and about a
			 * window's bytes; `cost`: what they are charged.
			 */
			const journalAfter = async (after: number, limit: number, ctx: Ctx, upTo = room.value.seq) => {
				const messages: Message[] = [];
				let bytes = 0;
				let cost = 0;
				const end = Math.floor(upTo / BLOCK);
				for (let block = Math.floor(Math.max(after + 1, info.value.from + 1) / BLOCK); block <= end; block++)
					for (const message of (await blocks.get(String(block), ctx))?.messages ?? []) {
						if (message.seq <= after || message.seq > upTo) continue;
						if (messages.length >= limit || (messages.length && bytes + 2 * message.data.length > WINDOW_BYTES))
							return { messages, more: true, cost };
						bytes += 2 * message.data.length;
						cost += messageCost(message);
						messages.push(message);
					}
				return { messages, more: false, cost };
			};

			/**
			 * The text room's document: rebuilt from the base and the journal after it (a reload's restart), or loaded
			 * from the room's own document (checked) with the view's text taken in, or the view's text with fresh IDs.
			 */
			const loadedText = async (ctx: Ctx) => {
				if (text) return text;
				const base = room.value.base;
				const fromBase = base ? loadText(base.value) : undefined;
				if (base && fromBase) {
					let doc = fromBase.doc;
					const marks = { ...fromBase.marks };
					for (let after = base.seq, more = true; more; ) {
						const page = await journalAfter(after, 1000, ctx);
						for (const message of page.messages) {
							after = message.seq;
							if (message.n === undefined) continue;
							doc = applyEdits(doc, parseEdits(message.data));
							if (message.n > (marks[message.from] ?? 0)) marks[message.from] = message.n;
						}
						more = page.more;
					}
					text = { doc, marks };
					return text;
				}
				const wanted = textOf(backing.current.value);
				const stored = loadText(backing.room.value);
				if (!stored) {
					text = { doc: freshText(wanted, bunch), marks: {} };
					return text;
				}
				// The view's text changed while no room was open (the agent, a page): taken as one edit over the stored
				// document, so its IDs (and pending edits of reconnecting frames) stay valid. Over the limit: not taken.
				if (wanted === stored.doc.text || wanted.length > MAX_TEXT) {
					text = stored;
					return text;
				}
				const edits = editsTo(stored.doc, wanted, (before, count) => ids.generateAfter(before, count));
				text = {
					doc: applyEdits(stored.doc, edits),
					marks: { ...stored.marks, [SERVER_EDITOR]: (stored.marks[SERVER_EDITOR] ?? 0) + 1 },
				};
				return text;
			};

			/**
			 * Writes the text room's text into the view's state and its own document (serialized). When the state changed
			 * meanwhile, that change is taken first (its newer value is here already: an answer follows its state); the
			 * text is then still unsaved, and the save routine runs again.
			 */
			const writeText = async (ctx: Ctx): Promise<void> => {
				const current = await loadedText(ctx);
				const upTo = info.value.textSeq;
				const value = { ...stateObject(backing.current.value), text: current.doc.text };
				const revision = seenRevision();
				if (await backing.write({ revision, value, room: textRoom(current) }, ctx))
					await info.change((draft) => {
						draft.seen = revision + 1;
						draft.savedSeq = Math.max(draft.savedSeq, upTo);
					}, ctx);
				else await takeOutside(backing.current.value, ctx);
			};

			/** A change of the view's state the room did not make: the agent's or a page's. */
			const takeOutside = async (state: BackedState, ctx: Ctx) => {
				if (state.revision === seenRevision()) return;
				await markSeen(state.revision, ctx);
				const kind = room.value.kind;
				if (kind === "log") {
					await rebase(state.value, (room.value.base?.epoch ?? 0) + 1, ctx);
					return;
				}
				if (kind !== "text") return;
				const current = await loadedText(ctx);
				const wanted = textOf(state);
				if (wanted === current.doc.text) return;
				// Over the limit: the room's text stays and is written back over the outside value.
				if (wanted.length > MAX_TEXT) {
					await info.change((draft) => {
						draft.textSeq = room.value.seq;
						draft.savedSeq = Math.min(draft.savedSeq, room.value.seq - 1);
					}, ctx);
					return;
				}
				const edits = editsTo(current.doc, wanted, (before, count) => ids.generateAfter(before, count));
				// The server's own batches continue its watermark (kept in the room's document across restarts).
				await logEdits(SERVER_EDITOR, (current.marks[SERVER_EDITOR] ?? 0) + 1, edits, ctx);
			};

			/** Applies a batch of edits and logs it (empty when its number is at or below its editor's watermark). */
			const logEdits = async (editor: string, n: number, edits: readonly TextEdit[], ctx: Ctx) => {
				const current = await loadedText(ctx);
				const fresh = n > (current.marks[editor] ?? 0);
				const data = JSON.stringify(fresh ? edits : []);
				// Published (and charged) first: a refused batch changes nothing.
				await publish(editor, [{ data, n }], ctx);
				if (fresh) text = { doc: applyEdits(current.doc, edits), marks: { ...current.marks, [editor]: n } };
				if (room.value.seq - (room.value.base?.seq ?? 0) >= TEXT_BASE_EVERY)
					await rebase(textRoom(await loadedText(ctx)), room.value.base?.epoch ?? 0, ctx);
			};

			// Presence: departed peers' keyed messages, offers and acknowledgements go; calls pinned to them end
			// uncertain (or go to the next leader if idempotent); the leader's term grows when the leader changes.
			self.on(presence, async ({ value }, ctx) => {
				const present = new Set(value.peers.map((each) => each.id));
				if (value.leader !== lastLeader) {
					lastLeader = value.leader;
					await room.change((draft) => {
						draft.term += 1;
					}, ctx);
				}
				for (const id of acks.keys()) if (!present.has(id)) acks.delete(id);
				const gone = Object.keys(keyed.value.peers).filter((id) => !present.has(id));
				if (gone.length)
					await charged(async (tx, ledger) => {
						const draft = await tx.draft(keyed);
						const account = await tx.draft(info);
						for (const id of gone) {
							for (const [key, entry] of Object.entries(draft.peers[id] ?? {})) {
								charge(account, -(keptEntry(key, entry.data) + ENTRY_COST), ledger);
								account.keyed -= encodedEntry(key, entry.data);
							}
							account.keyed -= encodedPeer(id);
							delete draft.peers[id];
						}
					}, ctx);
				const leftOffers = Object.keys(offers.value.peers).filter((id) => !present.has(id));
				if (leftOffers.length)
					await offers.change((draft) => {
						for (const id of leftOffers) delete draft.peers[id];
					}, ctx);
				for (const [id, call] of waiting) {
					if (present.has(call.peer)) continue;
					const leader = value.leader;
					const method = room.value.calls.find((each) => each.id === id)?.method;
					const offer = leader === null ? undefined : offers.value.peers[leader];
					if (
						call.idempotent &&
						leader !== null &&
						method &&
						offer?.methods.some((each) => each.name === method)
					) {
						call.peer = leader;
						call.offer = offer.n;
						await room.change((draft) => {
							const entry = draft.calls.find((each) => each.id === id);
							if (entry) entry.peer = leader;
						}, ctx);
					}
					// Given to a frame that left: it may have run, whether another frame is left or not.
					else settle(id, { kind: "failed", error: uncertain() });
				}
				await trimLive(ctx);
			});

			// A closed (or closed and reopened) view: its frames are revoked and its unused tokens dropped.
			self.on(openings.openings, async ({ value }, ctx) => {
				if (value[view] === opening) return;
				dropTokens(session, view, opening);
				await server.revokeFrames({ view: viewKey(session, view, opening) }, ctx);
			});

			// The view's state changed: an outside change resets a log room or becomes a text room's edit. The revision
			// last taken is the room's own (a document): a reload's new attempt compares it at its first call, so a change
			// made meanwhile is taken before anything is saved over it.
			self.on(backing.current, async ({ value }, ctx) => {
				const kind = room.value.kind;
				if (kind === null || kind === "live" || seenRevision() < 0) {
					if (value.revision !== seenRevision()) await markSeen(value.revision, ctx);
					return;
				}
				await serial(() => takeOutside(value, ctx));
			});

			// A text room's text not yet written (read from its documents: a reload's restart saves at once) is written
			// a little after the last edit, and while edits keep coming, at that pace.
			self.on(unsaved, async ({ value }, ctx) => {
				if (!value) return;
				// The flag stays true while edits keep coming: write until the text caught up.
				while (room.value.kind === "text" && info.value.textSeq > info.value.savedSeq) {
					await sleep(TEXT_WRITE_PAUSE, ctx);
					await serial(() => writeText(ctx));
				}
			});

			// Calls of an earlier attempt have nobody waiting for them; a live room's peer that stays behind everyone else
			// is disconnected: it rejoins after the messages it missed.
			self.onLive(async (ctx) => {
				if (room.value.calls.some((call) => !waiting.has(call.id)))
					await room.change((draft) => {
						draft.calls = draft.calls.filter((call) => waiting.has(call.id));
					}, ctx);
				for (;;) {
					await sleep(LAG_LIMIT / 6, ctx);
					if (room.value.kind !== "live") continue;
					for (const id of laggards(Date.now())) {
						acks.delete(id);
						await server.revokeFrames({ link: id }, ctx);
					}
					await trimLive(ctx);
				}
			});

			/** Present peers behind every other peer for longer than the limit. */
			const laggards = (now: number): string[] => {
				const present = [...peerIds()];
				const out: string[] = [];
				for (const id of present) {
					const own = acks.get(id);
					if (!own) continue;
					const others = present.filter((other) => other !== id).map((other) => acks.get(other)?.seq ?? 0);
					const behind = others.length > 0 && own.seq < Math.min(...others);
					if (!behind) own.behind = undefined;
					else if (own.behind === undefined) own.behind = now;
					else if (now - own.behind > LAG_LIMIT) out.push(id);
				}
				return out;
			};

			/** Settles call `id` (its waiting caller removes it from the room's calls). */
			const settle = (id: string, outcome: Outcome) => {
				const call = waiting.get(id);
				waiting.delete(id);
				call?.settle(outcome);
			};

			return {
				room,
				presence,
				log,
				keyed,
				join: async ({ peer, writer, kind }, ctx) => {
					const current = room.value;
					if (kind !== undefined && current.kind !== kind) {
						// Changing the kind starts the room over: only a frame that may write, and only when no other
						// frame uses the room.
						if (!writer)
							throw forbidden(`This view's room is a ${current.kind ?? "new"} room; this frame may only watch`);
						if (current.kind !== null && presence.value.peers.some((each) => each.id !== peer))
							throw invalid("args", `This view's room is a ${current.kind} room while frames use it`);
						await serial(() => resetRoom(kind, ctx));
					}
					acks.set(peer, { seq: room.value.seq });
					return { from: room.value.seq };
				},
				send: async ({ peer, messages, ack }, ctx) => {
					await publish(peer, messages, ctx);
					if (ack !== undefined) acks.set(peer, { ...acks.get(peer), seq: ack });
					await trimLive(ctx);
					return null;
				},
				ack: async ({ peer, seq }, ctx) => {
					acks.set(peer, { ...acks.get(peer), seq: Math.min(seq, room.value.seq) });
					await trimLive(ctx);
					return null;
				},
				history: async ({ after, limit }, ctx) => {
					const { messages, more } = await journalAfter(after, limit, ctx);
					return { messages, more };
				},
				offer: async ({ peer, methods }, ctx) => {
					const n = (offers.value.peers[peer]?.n ?? 0) + 1;
					await offers.change((draft) => {
						draft.peers[peer] = { n, methods };
					}, ctx);
					// Calls given to this peer under its earlier offer may or may not run now.
					for (const [id, call] of waiting)
						if (call.peer === peer && call.offer < n) settle(id, { kind: "failed", error: uncertain() });
					return null;
				},
				answer: async ({ peer, answer }) => {
					const call = waiting.get(answer.id);
					if (!call || call.peer !== peer) throw forbidden("this call is not this frame's");
					settle(
						answer.id,
						answer.error === undefined
							? { kind: "answered", result: answer.result ?? null }
							: { kind: "failed", error: new PluginError("method_failed", answer.error) },
					);
					return null;
				},
				snapshot: async ({ peer, snapshot }, ctx) => {
					if (room.value.kind !== "log") throw invalid("args", "Only log rooms take snapshots");
					// Checked in the serialized step, against the base as it is then: a snapshot overtaken by a newer
					// one (or by an outside change) never moves the base back.
					const fits = () => {
						const current = room.value;
						const base = current.base;
						return (
							presence.value.leader === peer &&
							base !== null &&
							snapshot.epoch === base.epoch &&
							snapshot.term === current.term &&
							snapshot.seq > base.seq &&
							snapshot.seq <= current.seq
						);
					};
					const written = await serial(async () => {
						if (!fits()) return false;
						// The snapshot's cost (its base, less the old base and the journal it replaces) is reserved before
						// the view's state is written: nothing persists that the room cannot take too.
						const old = room.value.base ? 2 * JSON.stringify(room.value.base.value).length : 0;
						const freed = (await journalAfter(info.value.from, Number.MAX_SAFE_INTEGER, ctx, snapshot.seq)).cost;
						const reserved = Math.max(0, 2 * JSON.stringify(snapshot.value).length - old - freed);
						if (memory.used + reserved > budget()) throw roomFull();
						memory.used += reserved;
						try {
							if (!(await backing.write({ revision: seenRevision(), value: snapshot.value }, ctx))) {
								await takeOutside(backing.current.value, ctx);
								return false;
							}
							await markSeen(seenRevision() + 1, ctx);
							if (!fits()) return false;
							await setBase({ seq: snapshot.seq, epoch: snapshot.epoch, value: snapshot.value }, ctx, reserved);
							return true;
						} finally {
							memory.used -= reserved;
						}
					});
					if (!written) throw invalid("args", "The snapshot is stale");
					return null;
				},
				edit: async ({ editor, batch }, ctx) => {
					if (room.value.kind !== "text") throw invalid("args", "Only text rooms take edits");
					await serial(() => logEdits(editor, batch.n, batch.edits, ctx));
					return null;
				},
				methods: async () => {
					const leader = presence.value.leader;
					if (leader === null) throw notOpen();
					return offers.value.peers[leader]?.methods ?? [];
				},
				call: async ({ method, args }, ctx) => {
					const leader = presence.value.leader;
					if (leader === null) throw notOpen();
					const offer = offers.value.peers[leader];
					const offered = offer?.methods.find((each) => each.name === method);
					if (!offer || !offered) throw invalid("args", `The view offers no method "${method}"`);
					const id = randomUUID();
					const call: Call = { id, method, args, peer: leader };
					const answered = new Promise<Outcome>((resolve) => {
						waiting.set(id, {
							peer: leader,
							offer: offer.n,
							idempotent: offered.idempotent === true,
							settle: resolve,
						});
					});
					// The wait ends with the answer, the timeout or the caller's cancellation, whichever comes first; the
					// call then leaves the room in the store's own scope (a cancelled caller's ctx cannot commit).
					const timer = withCancel(ctx);
					try {
						await room.change((draft) => {
							draft.calls.push(call);
						}, ctx);
						const outcome = await Promise.race([
							answered,
							// Ends at the timeout, or (rejecting) when the caller cancels or the answer came first.
							sleep(CALL_TIMEOUT, timer.context).then(
								(): Outcome => ({
									kind: "failed",
									error: new PluginError("timeout", "The view did not answer within a minute"),
								}),
								(error: unknown): Outcome => ({
									kind: "failed",
									error: error instanceof Error ? error : new PluginError("aborted", "The call was cancelled"),
								}),
							),
						]);
						if (outcome.kind === "failed") throw outcome.error;
						return outcome.result;
					} finally {
						timer.cancel();
						waiting.delete(id);
						if (room.value.calls.some((each) => each.id === id))
							await room.change((draft) => {
								draft.calls = draft.calls.filter((each) => each.id !== id);
							}, withoutAbortSignal(ctx));
					}
				},
			};

			/** Starts the room over as a room of `kind`. */
			async function resetRoom(kind: "live" | "log" | "text", ctx: Ctx) {
				text = undefined;
				const state = backing.current.value;
				await markSeen(state.revision, ctx);
				const epoch = (room.value.base?.epoch ?? 0) + 1;
				await setBase(null, ctx);
				await room.change((draft) => {
					draft.kind = kind;
				}, ctx);
				await trimTo(room.value.seq, ctx);
				if (kind === "log") await rebase(state.value, epoch, ctx);
				if (kind === "text") await rebase(textRoom(await loadedText(ctx)), epoch, ctx);
			}
		},
		{ linger: 10_000 },
	);
}

/** How a call ends: its frame's answer, or why not. */
type Outcome =
	| { readonly kind: "answered"; readonly result: JsonValue }
	| { readonly kind: "failed"; readonly error: Error };

/** The budget refuses. */
const roomFull = () =>
	new PluginError(
		"room_full",
		"The views' rooms keep too much memory now; try again once peers caught up (settings.json viewRoomsMemory)",
	);

/** No frame that may answer shows the view. */
const notOpen = () => new PluginError("not_open", "The view is not open in any browser that may answer");

/** "The call may or may not have run". */
const uncertain = () =>
	new PluginError(
		"uncertain",
		"The view's leader left or changed its methods before answering: it may or may not have run",
	);

/** A journal message's cost: its strings (UTF-16) and its entry. */
const messageCost = (message: Message): number => 2 * (message.data.length + message.from.length) + ENTRY_COST;

/** A keyed entry's strings in memory (UTF-16). */
const keptEntry = (key: string, data: string): number => 2 * (key.length + data.length);

/**
 * A keyed entry's share of the keyed member's encoding as the wire carries it: the UTF-8 bytes of its key and data as
 * JSON strings (escapes included) and the rest of the entry (`KEYED_ENCODING`).
 */
const encodedEntry = (key: string, data: string): number =>
	Buffer.byteLength(JSON.stringify(key)) + Buffer.byteLength(JSON.stringify(data)) + KEYED_ENCODING;

/** A peer's own share of the keyed member's encoding: its ID as a JSON key and its object's braces. */
const encodedPeer = (id: string): number => Buffer.byteLength(JSON.stringify(id)) + KEYED_PEER;

/** The text room's document as stored and as its base. */
function textRoom(current: { doc: TextDoc; marks: Record<string, number> }): JsonValue {
	const saved = saveText(current.doc, current.marks);
	return { text: saved.text, textIds: saved.textIds, textMarks: saved.textMarks };
}

/** A view state's text (none: empty). */
function textOf(state: BackedState): string {
	const value = state.value;
	return isRecord(value) && typeof value.text === "string" ? value.text : "";
}

/** A view state's value as an object (another value: an empty one). */
function stateObject(state: BackedState): Record<string, JsonValue> {
	return isRecord(state.value) ? state.value : {};
}

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A logged batch's edits (the server wrote them: they parse). */
function parseEdits(data: string): TextEdit[] {
	return JSON.parse(data) as TextEdit[];
}
