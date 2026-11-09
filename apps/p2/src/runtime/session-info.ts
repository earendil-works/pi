// The session's own description (`p2.session-info`): what the catalog lists it by, kept in the session itself so the
// session is the authority for it and it travels with the session's store (a copy, a synced replica). The server's
// catalog is a mirror: the session's worker reports the document after every change (`Sessions.describeSelf`), and
// an edit made through the server is committed here first (`SessionInfo.edit`, or the stopped session's store).
import type { Context } from "@earendil-works/chord/context";
import { createSession, type DocumentReader, defineDoc, type Session } from "@earendil-works/pi-durable";
import { openSessionStorage } from "./session-store.ts";
import type { SessionInit } from "./session-worker.ts";

/** A model reference as the catalog keeps it. */
export type SessionModel = { provider: string; modelId: string };

/**
 * `p2.session-info`: the session's description. `titleEdited`: the title was given or renamed, so an automatic title
 * (the first user message) never replaces it. `archivedAt`: when the session was archived, or null. `createdAt` is 0
 * only in the document's initial value: a description is always written from a seed first.
 */
export type SessionInfoState = {
	title: string;
	titleEdited: boolean;
	cwd: string;
	env: string | null;
	pinned: boolean;
	archivedAt: number | null;
	model: SessionModel;
	thinkingLevel: string;
	createdAt: number;
};

/** The automatic title of a session: its first user message, line breaks as spaces, its first 100 characters. */
export const AUTO_TITLE_LENGTH = 100;

/**
 * The session's description, session-scoped (a fork's new session starts its own). Every write carries a seed (the
 * catalog row): the first one writes it, so sessions from before the document get theirs from the catalog.
 */
export const SessionInfoDoc = defineDoc<SessionInfoState>({
	kind: "p2.session-info",
	version: 1,
	scope: "session",
	initial: () => ({
		title: "New session",
		titleEdited: false,
		cwd: "",
		env: null,
		pinned: false,
		archivedAt: null,
		model: { provider: "", modelId: "" },
		thinkingLevel: "high",
		createdAt: 0,
	}),
	checkpointWhen: () => true,
});

/** A change to the description, as the server or the worker asks for it; absent fields stay. */
export type SessionInfoEdit = {
	readonly title?: string | undefined;
	/** With `title`: whether it was given (rename, creation) rather than automatic (the first user message). */
	readonly titleEdited?: boolean | undefined;
	readonly cwd?: string | undefined;
	readonly env?: string | null | undefined;
	readonly pinned?: boolean | undefined;
	readonly archivedAt?: number | null | undefined;
	readonly model?: SessionModel | undefined;
	readonly thinkingLevel?: string | undefined;
};

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The description, or undefined for a session nobody wrote one for yet. */
export async function readSessionInfo(read: DocumentReader, context: Context): Promise<SessionInfoState | undefined> {
	const state = (await read.snapshot(SessionInfoDoc, context)) as SessionInfoState | undefined;
	return state === undefined || state.createdAt === 0 ? undefined : copy(state);
}

/**
 * Applies `edit` in one commit, after writing `seed` when the session has no description yet (in the same commit, so
 * nothing can write before the seed). An automatic title (`titleEdited` not true) does not replace a given one.
 * Resolves with the description after the edit.
 */
export async function editSessionInfo(
	session: Pick<Session, "commit">,
	edit: SessionInfoEdit,
	seed: SessionInfoState,
	context: Context,
): Promise<SessionInfoState> {
	return session.commit(async (tx) => {
		const draft = await tx.doc(SessionInfoDoc);
		if (draft.createdAt === 0) Object.assign(draft, copy(seed));
		if (edit.title !== undefined && (edit.titleEdited === true || !draft.titleEdited)) {
			draft.title = edit.title;
			if (edit.titleEdited === true) draft.titleEdited = true;
		}
		if (edit.cwd !== undefined) draft.cwd = edit.cwd;
		if (edit.env !== undefined) draft.env = edit.env;
		if (edit.pinned !== undefined) draft.pinned = edit.pinned;
		if (edit.archivedAt !== undefined) draft.archivedAt = edit.archivedAt;
		if (edit.model !== undefined) draft.model = { provider: edit.model.provider, modelId: edit.model.modelId };
		if (edit.thinkingLevel !== undefined) draft.thinkingLevel = edit.thinkingLevel;
		return copy(draft) as SessionInfoState;
	}, context);
}

/**
 * Replaces the whole description: a cloned session's store holds its source's, which the clone's own catalog row
 * replaces before anything reads it.
 */
export async function writeSessionInfo(
	session: Pick<Session, "commit">,
	state: SessionInfoState,
	context: Context,
): Promise<void> {
	await session.commit(async (tx) => {
		Object.assign(await tx.doc(SessionInfoDoc), copy(state));
	}, context);
}

/**
 * The seed a worker writes the description from when the session has none: the catalog row the server sent with the
 * start data (`SessionInit.info`), else what the start data says (a server from before the description).
 */
export function sessionInfoSeed(session: SessionInit, now: () => number = Date.now): SessionInfoState {
	return (
		session.info ?? {
			title: "New session",
			titleEdited: false,
			cwd: session.cwd,
			env: session.env ?? null,
			pinned: false,
			archivedAt: null,
			model: { provider: session.model.provider, modelId: session.model.modelId },
			thinkingLevel: session.thinkingLevel,
			createdAt: now(),
		}
	);
}

/**
 * Runs `fn` on a stopped session's Durable records (its store, `openSessionStorage`): the caller holds the worker
 * stopped (a pause, a relocation's update step), as one process runs a store at a time.
 */
export async function withStoredSession<T>(
	dataDir: string,
	id: string,
	fn: (session: Session) => Promise<T>,
	context: Context,
): Promise<T> {
	const opened = await openSessionStorage(dataDir, id, context);
	const session = createSession(opened.storage);
	try {
		return await fn(session);
	} finally {
		await session.close(context).catch(() => {});
		await opened.store.close(context);
	}
}
