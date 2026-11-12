// Artifacts (docs/artifacts.md): a session's html pages and Markdown documents the agent writes, with every version and
// an html page's state, kept on the server per session (data of the server's store belonging to the session's host
// address: a session's export, import and delete carry them). People list, open and remove them; the
// session's worker writes them for its agent; an open html page reports its errors and logs, and runs the agent's code.
import { arr, int, nullable, num, obj, oneOf, opt, type Static, str, union, unknown } from "@earendil-works/pi-schema";
import { type JsonValue, literal, method, param, remote, serverHost, unsafe } from "@p2/app/v1";

/** An artifact's ID: a lowercase slug, unique in its session. */
export const ARTIFACT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The largest version's content, as UTF-8. */
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
/** The largest state an html page keeps, as JSON. */
export const MAX_ARTIFACT_STATE = 256 * 1024;

const Id = str({ pattern: ARTIFACT_ID.source });
/** An exact replacement in an artifact's newest content: `old` must occur exactly once. */
const EditSchema = obj({ old: str({ minLength: 1 }), new: str() });

/** The kinds of artifacts: an html page in a sandboxed frame, a Markdown document. */
export const ArtifactKindSchema = oneOf(["html", "md"] as const);
export type ArtifactKind = Static<typeof ArtifactKindSchema>;

/** An artifact as lists show it: its kind, title, newest version and when it last changed. */
export const ArtifactSummarySchema = obj({
	id: Id,
	kind: ArtifactKindSchema,
	title: str({ minLength: 1, maxLength: 200 }),
	version: int({ minimum: 1 }),
	updated: num(),
});
export type ArtifactSummary = Static<typeof ArtifactSummarySchema>;

/** A version's content with its artifact's summary. */
export const ReadSchema = obj({ summary: ArtifactSummarySchema, version: int({ minimum: 1 }), content: str() });

/** What reading takes: an artifact, and a version (default its newest). */
export const ReadArgsSchema = obj({ id: Id, version: opt(int({ minimum: 1 })) });

/** What writing takes: a new artifact (its ID made from the title when not given) or the next version of one. */
export const WriteSchema = obj({
	id: opt(Id),
	kind: ArtifactKindSchema,
	title: str({ minLength: 1, maxLength: 200 }),
	content: str(),
});

/** What editing takes: exact replacements in an artifact's newest content. */
export const EditArgsSchema = obj({ id: Id, edits: arr(EditSchema, { minItems: 1, maxItems: 100 }) });

/** What an html page logged: its level and text, numbered in the order the server got it. */
export const LogEntrySchema = obj({ seq: int(), level: str(), text: str(), at: num() });
export type LogEntry = Static<typeof LogEntrySchema>;

/** The result of code an open page ran: its JSON value, or the error it threw. */
const EvalResultSchema = union([
	obj({ ok: literal(true), value: unsafe<JsonValue>(unknown()) }),
	obj({ ok: literal(false), error: str() }),
]);
export type EvalResult = Static<typeof EvalResultSchema>;

/**
 * A session's artifacts (server): everyone who may view the session lists and reads them, people who may send there also
 * remove them, and the session's worker does what its agent's tools do.
 */
export const Artifacts = remote("p2.artifacts", {
	version: 1,
	params: { session: param.str() },
	hostAddress: serverHost,
	variants: {
		reader: {
			state: { artifacts: arr(ArtifactSummarySchema) },
			methods: { read: method(ReadArgsSchema, ReadSchema) },
		},
		editor: {
			state: { artifacts: arr(ArtifactSummarySchema) },
			methods: {
				read: method(ReadArgsSchema, ReadSchema),
				remove: method(obj({ id: Id })),
			},
		},
		worker: {
			methods: {
				list: method(undefined, arr(ArtifactSummarySchema)),
				read: method(obj({ id: Id, version: opt(int({ minimum: 1 })) }), ReadSchema),
				/** A new artifact (its ID made from the title when not given) or the next version of one. */
				write: method(WriteSchema, obj({ id: Id, version: int() })),
				edit: method(EditArgsSchema, obj({ version: int() })),
				remove: method(obj({ id: Id })),
				/** An html page's state as stored (null until something set it). */
				readState: method(obj({ id: Id }), obj({ state: unsafe<JsonValue>(unknown()) })),
				setState: method(obj({ id: Id, state: unsafe<JsonValue>(unknown()) })),
				/** The errors the open pages of an html artifact reported, oldest first. */
				errors: method(obj({ id: Id }), arr(LogEntrySchema)),
				/** What the open pages logged after `since` (a `seq`), and the newest `seq`. */
				logs: method(obj({ id: Id, since: opt(int()) }), obj({ logs: arr(LogEntrySchema), next: int() })),
				/** Runs `code` in a page of the artifact open on some device; fails when none is open. */
				eval: method(obj({ id: Id, code: str({ maxLength: 100_000 }) }), EvalResultSchema),
				/** Errors no message carried yet, with the marks `carried` takes once one did. */
				newErrors: method(
					undefined,
					obj({
						errors: arr(obj({ id: Id, title: str(), text: str() })),
						marks: arr(obj({ id: Id, seq: int() })),
					}),
				),
				carried: method(obj({ marks: arr(obj({ id: Id, seq: int() })) })),
			},
		},
	},
});

/**
 * One html artifact as a page showing it holds it: its summary (null once it is removed) and state (`value`), its side of the
 * agent's requests (an event per request, answered with `answer`), and what the page reports. People who may send also
 * save the state.
 */
export const ArtifactPage = remote("p2.artifact-page", {
	version: 1,
	params: { session: param.str(), id: param.str() },
	hostAddress: serverHost,
	variants: {
		viewer: {
			state: { summary: nullable(ArtifactSummarySchema), value: unsafe<JsonValue>(unknown()) },
			events: { request: obj({ request: str(), code: str() }) },
			methods: {
				report: method(
					obj({
						errors: arr(str({ maxLength: 4000 }), { maxItems: 100 }),
						logs: arr(obj({ level: str({ maxLength: 16 }), text: str({ maxLength: 4000 }) }), { maxItems: 500 }),
					}),
				),
				answer: method(obj({ request: str(), result: EvalResultSchema })),
			},
		},
		editor: {
			state: { summary: nullable(ArtifactSummarySchema), value: unsafe<JsonValue>(unknown()) },
			events: { request: obj({ request: str(), code: str() }) },
			methods: {
				report: method(
					obj({
						errors: arr(str({ maxLength: 4000 }), { maxItems: 100 }),
						logs: arr(obj({ level: str({ maxLength: 16 }), text: str({ maxLength: 4000 }) }), { maxItems: 500 }),
					}),
				),
				answer: method(obj({ request: str(), result: EvalResultSchema })),
				setState: method(obj({ state: unsafe<JsonValue>(unknown()) })),
			},
		},
	},
});
