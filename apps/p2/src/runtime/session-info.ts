// The session's own description (`p2.session-info`): the content the session owns and its worker reports
// (`plugin-practices.md` rule 1): its title, whether a person gave that title, and its model and thinking level.
// Where it runs, whether it is archived, when it was made and whether it is pinned are the server's (its catalog). The
// worker writes the document only by applying the server's pending edits (`p2.session-pending-edits`) and its own
// changes (the `rename_session` tool, a model change in chat): one writer, the session's worker.
import type { Context } from "@earendil-works/chord/context";
import { type DocumentReader, defineDoc, type Session } from "@earendil-works/pi-durable";
import {
	applyEdit,
	type PendingEdit,
	type SessionInfoDocState,
	type SessionInfoEdit,
	type SessionInfoState,
	type SessionReport,
} from "./session-info-schema.ts";
import type { SessionInit } from "./session-worker.ts";

/**
 * The document: `unwritten` until the worker first wrote it (a session from before it, a new session's first start),
 * then the session's description. Absent means the same; the worker writes it from its start data then.
 */
export const SessionInfoDoc = defineDoc<{ state: SessionInfoDocState }>({
	kind: "p2.session-info",
	version: 1,
	scope: "session",
	initial: () => ({ state: { kind: "unwritten" } }),
	checkpointWhen: () => true,
});

/** The description, or undefined when the worker has not written it yet. */
export async function readSessionInfo(
	read: DocumentReader,
	context: Context,
): Promise<Readonly<SessionInfoState> | undefined> {
	const document = await read.snapshot(SessionInfoDoc, context);
	return document?.state.kind === "written" ? document.state.info : undefined;
}

/**
 * Applies `edits` in order in one commit, the description written from `seed` first when the session has none. A
 * pending edit (with a `revision`) applies only when newer than the last one the session applied, which it then
 * records; the session's own changes (no revision) always apply. Resolves once committed: read the description after
 * with `readSessionInfo`.
 */
export async function applySessionInfoEdits(
	session: Pick<Session, "commit">,
	edits: readonly (SessionInfoEdit | PendingEdit)[],
	seed: Readonly<SessionInfoState>,
	context: Context,
): Promise<void> {
	await session.commit(async (tx) => {
		const document = await tx.doc(SessionInfoDoc);
		if (document.state.kind === "unwritten")
			document.state = {
				kind: "written",
				info: {
					title: seed.title,
					titleEdited: seed.titleEdited,
					model: { provider: seed.model.provider, modelId: seed.model.modelId },
					thinkingLevel: seed.thinkingLevel,
				},
				applied: null,
			};
		const state = document.state;
		// Written just above when it was not: the union's other side.
		if (state.kind !== "written") return;
		for (const edit of edits) {
			if ("revision" in edit) {
				if (state.applied !== null && edit.revision <= state.applied) continue;
				state.applied = edit.revision;
			}
			applyEdit(state.info, edit);
		}
	}, context);
}

/** The session's report (`Sessions.describeSelf`): its description and the last pending edit it applied. */
export async function readSessionReport(read: DocumentReader, context: Context): Promise<SessionReport | undefined> {
	const document = await read.snapshot(SessionInfoDoc, context);
	if (document?.state.kind !== "written") return undefined;
	const { info, applied } = document.state;
	return {
		title: info.title,
		titleEdited: info.titleEdited,
		model: info.model,
		thinkingLevel: info.thinkingLevel,
		applied,
	};
}

/**
 * The description a session without `p2.session-info` starts from: the catalog row's (`SessionInit.info`), else what the
 * start data says (a server from before the description).
 */
export function sessionSeed(session: SessionInit): SessionInfoState {
	return (
		session.info ?? {
			title: "New session",
			titleEdited: false,
			model: { provider: session.model.provider, modelId: session.model.modelId },
			thinkingLevel: session.thinkingLevel,
		}
	);
}
