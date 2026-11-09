// The session's own description (`p2.session-info`) as data: its schemas and types, browser-safe (contracts import
// them). The Durable document and the code that writes it are `session-info.ts` (Node).
import { bool, int, nul, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { literal, propertiesOf } from "./schema.ts";
import { ModelRefSchema, ThinkingLevelSchema } from "./schemas.ts";

/** What the session holds: its title (`titleEdited`: a person gave it), model and thinking level. */
export const SessionInfoSchema = obj({
	title: str(),
	titleEdited: bool(),
	model: ModelRefSchema,
	thinkingLevel: ThinkingLevelSchema,
});
export type SessionInfoState = Static<typeof SessionInfoSchema>;

/**
 * A change of the description the server keeps until the session's worker applied it: a person's rename (`titleEdited`
 * true), an automatic title (false, applied only while no person gave one) or a model or level. `revision` orders the
 * session's edits; the worker reports the highest one it applied.
 */
export const PendingEditSchema = obj({
	revision: int({ minimum: 1 }),
	title: opt(str()),
	titleEdited: opt(bool()),
	model: opt(ModelRefSchema),
	thinkingLevel: opt(ThinkingLevelSchema),
});
export type PendingEdit = Static<typeof PendingEditSchema>;

/** A change without its revision: what the worker's own changes and the server's edits carry. */
export const SessionInfoEditSchema = obj({
	title: opt(str()),
	titleEdited: opt(bool()),
	model: opt(ModelRefSchema),
	thinkingLevel: opt(ThinkingLevelSchema),
});
export type SessionInfoEdit = Static<typeof SessionInfoEditSchema>;

/**
 * The document's state: `unwritten` until the worker first wrote it, then the session's description and the highest
 * pending edit it applied (null for none), so an edit is applied once, also across a crash before the report.
 */
export const SessionInfoDocStateSchema = union([
	obj({ kind: literal("unwritten") }),
	obj({ kind: literal("written"), info: SessionInfoSchema, applied: union([int({ minimum: 1 }), nul()]) }),
]);
export type SessionInfoDocState = Static<typeof SessionInfoDocStateSchema>;

/** The described session's report (`Sessions.describeSelf`): what it holds, and the last pending edit it applied. */
export const SessionReportSchema = obj({
	...propertiesOf(SessionInfoSchema),
	applied: union([int({ minimum: 1 }), nul()]),
});
export type SessionReport = Static<typeof SessionReportSchema>;

/**
 * Applies `edit` to `info` in place, changing only the fields it changes (`info` may be a Durable draft: an unchanged
 * field records no op). An automatic title (`titleEdited` not true) changes only a title no person gave. The worker's
 * commit and the catalog's overlay of pending edits both use it.
 */
export function applyEdit(info: SessionInfoState, edit: SessionInfoEdit): void {
	if (edit.title !== undefined && (edit.titleEdited === true || !info.titleEdited)) {
		if (info.title !== edit.title) info.title = edit.title;
		if (edit.titleEdited === true && !info.titleEdited) info.titleEdited = true;
	}
	if (
		edit.model !== undefined &&
		(info.model.provider !== edit.model.provider || info.model.modelId !== edit.model.modelId)
	)
		info.model = { provider: edit.model.provider, modelId: edit.model.modelId };
	if (edit.thinkingLevel !== undefined && info.thinkingLevel !== edit.thinkingLevel)
		info.thinkingLevel = edit.thinkingLevel;
}

/** Whether two descriptions hold the same values. */
export function sameInfo(a: Readonly<SessionInfoState>, b: Readonly<SessionInfoState>): boolean {
	return (
		a.title === b.title &&
		a.titleEdited === b.titleEdited &&
		a.model.provider === b.model.provider &&
		a.model.modelId === b.model.modelId &&
		a.thinkingLevel === b.thinkingLevel
	);
}
